import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { isTypeOnlyModule } from "../shared/scope.js";
import { packageOwner } from "./package-owner.js";

const aliasesByDirectory = new Map();
const aliasesByConfig = new Map();
const EMPTY_ALIASES = { exact: new Set(), prefixes: new Set() };

function stripJsonc(text) {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index++;
      stripped += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        if (text[index] === "\n") stripped += "\n";
        index++;
      }
      index++;
      continue;
    }
    if (char === ",") {
      let following = index + 1;
      while (/\s/u.test(text[following] ?? "")) following++;
      if (text[following] === "}" || text[following] === "]") continue;
    }
    stripped += char;
  }
  return stripped;
}

function emptyAliases() {
  return { exact: new Set(), prefixes: new Set() };
}

function mergeAliases(target, source) {
  for (const alias of source.exact) target.exact.add(alias);
  for (const prefix of source.prefixes) target.prefixes.add(prefix);
}

function readConfigAliases(configPath, visiting = new Set()) {
  if (aliasesByConfig.has(configPath)) return aliasesByConfig.get(configPath);
  if (visiting.has(configPath)) return EMPTY_ALIASES;
  visiting.add(configPath);
  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));
  } catch {
    const empty = emptyAliases();
    aliasesByConfig.set(configPath, empty);
    return empty;
  }
  const aliases = emptyAliases();
  const extended = config?.extends;
  if (typeof extended === "string" && extended.startsWith(".")) {
    const base = resolve(dirname(configPath), extended);
    const inheritedPath = [base, `${base}.json`].find((candidate) =>
      existsSync(candidate)
    );
    if (inheritedPath) {
      mergeAliases(aliases, readConfigAliases(inheritedPath, visiting));
    }
  }
  const paths = config?.compilerOptions?.paths;
  if (paths && typeof paths === "object" && !Array.isArray(paths)) {
    for (const key of Object.keys(paths)) {
      if (key.endsWith("/*")) {
        aliases.prefixes.add(key.slice(0, -1));
        aliases.exact.add(key.slice(0, -2));
      } else if (!key.includes("*")) {
        aliases.exact.add(key);
        aliases.prefixes.add(`${key}/`);
      }
    }
  }
  visiting.delete(configPath);
  aliasesByConfig.set(configPath, aliases);
  return aliases;
}

function configuredPathAliases(filename) {
  const start = dirname(resolve(filename));
  if (aliasesByDirectory.has(start)) return aliasesByDirectory.get(start);
  const visited = [];
  let directory = start;
  let aliases = EMPTY_ALIASES;
  for (;;) {
    visited.push(directory);
    let configPath = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (configPath) {
      aliases = readConfigAliases(configPath);
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const seen of visited) aliasesByDirectory.set(seen, aliases);
  return aliases;
}

function typesPackageName(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    return `@types/${scope}__${name}`;
  }
  return `@types/${packageName}`;
}

function configuredDependencies(context) {
  const allowDevDeps = context.options[0]?.allowDevDependencies !== false;
  const owner = packageOwner(context.filename ?? context.getFilename());
  const manifest = owner?.manifest ?? {};
  const dependencies = new Set([
    manifest.name,
    ...[
      manifest.dependencies,
      ...(allowDevDeps ? [manifest.devDependencies] : []),
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].flatMap((group) => Object.keys(group ?? {})),
  ]);
  if (allowDevDeps && context.options[0]?.ancestorDevDependencies !== false) {
    let current = owner;
    while (current && dirname(current.directory) !== current.directory) {
      current = packageOwner(
        join(dirname(current.directory), "__dependency_probe__.js")
      );
      for (const name of Object.keys(current?.manifest.devDependencies ?? {})) {
        dependencies.add(name);
      }
    }
  }
  return dependencies;
}

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          internalPrefixes: { type: "array", items: { type: "string" } },
          ancestorDevDependencies: { type: "boolean" },
          allowDevDependencies: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unlisted:
        "Declare '{{name}}' in the importing package's package.json; that package owns its dependency contract.",
      unlistedTypes:
        "Declare '{{name}}' or its type provider in the importing package's package.json; that package owns its type dependency contract.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const filename = context.filename ?? context.getFilename();
    const dependencies = configuredDependencies(context);
    const aliases = configuredPathAliases(filename);
    const prefixes = new Set([
      "@/",
      "~/",
      ...(context.options[0]?.internalPrefixes ?? []),
      ...aliases.prefixes,
    ]);
    function inspect(node) {
      const source = node.source?.value;
      if (
        typeof source !== "string" ||
        isBuiltin(source) ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("#") ||
        aliases.exact.has(source) ||
        [...prefixes].some((prefix) => source.startsWith(prefix)) ||
        /^[a-z]+:/u.test(source)
      ) {
        return;
      }
      const name = source.startsWith("@")
        ? source.split("/").slice(0, 2).join("/")
        : source.split("/")[0];
      const typeOnly = isTypeOnlyModule(node);
      if (
        dependencies.has(name) ||
        (typeOnly && dependencies.has(typesPackageName(name)))
      ) {
        return;
      }
      context.report({
        node,
        messageId: typeOnly ? "unlistedTypes" : "unlisted",
        data: { name },
      });
    }
    return {
      ImportDeclaration: inspect,
      ExportNamedDeclaration: inspect,
      ExportAllDeclaration: inspect,
      ImportExpression: inspect,
    };
  },
};
