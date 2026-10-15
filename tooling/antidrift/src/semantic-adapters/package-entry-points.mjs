import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

import ts from "typescript";

import {
  compilerOutputs,
  exportTarget,
  moduleExportTargets,
  packageSources,
  unwrapped,
} from "./typescript-engine.mjs";

const packageSurfaces = new WeakMap();

const ENTRY_FIELDS = ["main", "module", "types", "typings", "browser", "bin"];
const SCRIPT_ENTRY = /(?:\.[cm]?[jt]sx?|\/[^./]*)$/u;
const SOURCE_EXTENSION = /\.[cm]?tsx?$/u;
const OUTPUT_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SCRIPT_SEQUENCERS = new Set(["run-s", "run-p", "npm-run-all"]);
const COMMAND_PREFIXES = new Set(["npx", "bunx", "cross-env", "exec"]);
const TOOL_CONFIG_STEMS = {
  tsup: "tsup.config",
  tsdown: "tsdown.config",
  vite: "vite.config",
  rollup: "rollup.config",
  unbuild: "build.config",
  rslib: "rslib.config",
  webpack: "webpack.config",
};
const CONFIG_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"];
const POSITIONAL_ENTRY_TOOLS = new Set(["tsup", "tsdown", "esbuild"]);
const TOOL_ENTRY_PATHS = {
  tsup: [["entry"]],
  tsdown: [["entry"]],
  vite: [
    ["build", "lib", "entry"],
    ["build", "rollupOptions", "input"],
  ],
  rollup: [["input"]],
  unbuild: [["entries"]],
  rslib: [["source", "entry"]],
  webpack: [["entry"]],
};
const TOOL_PACKAGES = {
  tsup: ["tsup"],
  tsdown: ["tsdown"],
  vite: ["vite"],
  rollup: ["rollup"],
  unbuild: ["unbuild"],
  rslib: ["@rslib/core"],
  webpack: [],
};
const ALLOWED_CONSTANT_USES = new Set([
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.ArrayLiteralExpression,
]);

function isManifestFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function propertyKey(property, sourceFile) {
  return property.name.getText(sourceFile).replace(/^["']|["']$/gu, "");
}

function configurationReader(sourceFile, tool) {
  const constants = new Map();
  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          constants.set(declaration.name.text, declaration);
        }
      }
    }
  }
  const toolDefineConfig = new Set();
  for (const statement of sourceFile.statements) {
    const bindings =
      ts.isImportDeclaration(statement) &&
      TOOL_PACKAGES[tool].includes(statement.moduleSpecifier.text)
        ? statement.importClause?.namedBindings
        : undefined;
    for (const element of bindings && ts.isNamedImports(bindings)
      ? bindings.elements
      : []) {
      if ((element.propertyName ?? element.name).text === "defineConfig") {
        toolDefineConfig.add(element.name.text);
      }
    }
  }
  const identifierUses = new Map();
  (function collect(node) {
    const parent = node.parent;
    if (
      ts.isIdentifier(node) &&
      (parent.name !== node || ts.isShorthandPropertyAssignment(parent))
    ) {
      const uses = identifierUses.get(node.text) ?? [];
      uses.push(node);
      identifierUses.set(node.text, uses);
    }
    ts.forEachChild(node, collect);
  })(sourceFile);
  function isToolDefineConfig(node) {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      toolDefineConfig.has(node.expression.text) &&
      node.arguments.length === 1
    );
  }
  function onlyRead(name) {
    return (identifierUses.get(name) ?? []).every((use) => {
      const parent = use.parent;
      if (ts.isShorthandPropertyAssignment(parent)) return true;
      if (ts.isPropertyAssignment(parent)) return parent.initializer === use;
      if (isToolDefineConfig(parent)) return parent.arguments[0] === use;
      return (
        ALLOWED_CONSTANT_USES.has(parent.kind) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === use &&
          parent.left.getText(sourceFile) === "module.exports")
      );
    });
  }
  function constantSetting(name, seen) {
    const declaration = constants.get(name);
    if (!declaration?.initializer || !onlyRead(name) || seen.has(name)) {
      return null;
    }
    return evaluate(declaration.initializer, new Set([...seen, name]));
  }
  function objectSetting(node, seen) {
    const entries = new Map();
    for (const property of node.properties) {
      if (property.name && ts.isComputedPropertyName(property.name)) {
        return null;
      }
      if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression, seen);
        if (spread?.kind !== "object") return null;
        for (const [key, setting] of spread.entries) entries.set(key, setting);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        entries.set(property.name.text, () =>
          constantSetting(property.name.text, seen)
        );
      } else if (ts.isPropertyAssignment(property)) {
        entries.set(propertyKey(property, sourceFile), () =>
          evaluate(property.initializer, seen)
        );
      } else {
        entries.set(propertyKey(property, sourceFile), () => null);
      }
    }
    return { kind: "object", entries };
  }
  function arraySetting(node, seen) {
    const elements = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evaluate(element.expression, seen);
        if (spread?.kind !== "array") return null;
        elements.push(...spread.elements);
      } else {
        elements.push(() => evaluate(element, seen));
      }
    }
    return { kind: "array", elements };
  }
  function evaluate(node, seen) {
    const expression = unwrapped(node);
    if (ts.isStringLiteralLike(expression)) {
      return { kind: "string", text: expression.text };
    }
    if (ts.isIdentifier(expression)) {
      return constantSetting(expression.text, seen);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return objectSetting(expression, seen);
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return arraySetting(expression, seen);
    }
    if (isToolDefineConfig(expression)) {
      return evaluate(expression.arguments[0], seen);
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      const { body } = expression;
      if (!ts.isBlock(body)) return evaluate(body, seen);
      const [statement] = body.statements;
      return body.statements.length === 1 &&
        ts.isReturnStatement(statement) &&
        statement.expression
        ? evaluate(statement.expression, seen)
        : null;
    }
    return null;
  }
  return (node) => evaluate(node, new Set());
}

function exportedConfiguration(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) return statement.expression;
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sourceFile) === "module.exports"
    ) {
      return statement.expression.right;
    }
  }
  return undefined;
}

function entryInputs(setting, name) {
  if (!setting) return null;
  if (setting.kind === "string") return [{ name, input: setting.text }];
  if (setting.kind === "array") {
    const inputs = setting.elements.map((readSetting) =>
      entryInputs(readSetting(), undefined)
    );
    return inputs.includes(null) ? null : inputs.flat();
  }
  const nested = setting.entries.get("input") ?? setting.entries.get("import");
  if (nested) return entryInputs(nested(), name);
  const inputs = [...setting.entries].map(([key, readSetting]) =>
    entryInputs(readSetting(), key)
  );
  return inputs.includes(null) ? null : inputs.flat();
}

function configurationInputs(configuration, path) {
  let setting = configuration;
  for (const key of path) {
    if (setting?.kind !== "object") return null;
    const entry = setting.entries.get(key);
    if (!entry) return [];
    setting = entry();
  }
  return entryInputs(setting, undefined);
}

function declaredBuildInputs(configFile, tool) {
  const name = posix.basename(configFile);
  const sourceFile = ts.createSourceFile(
    configFile,
    readFileSync(configFile, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const exported = exportedConfiguration(sourceFile);
  if (!exported) return { unresolved: `${name} has no default export` };
  const exportedSetting = configurationReader(sourceFile, tool)(exported);
  const configurations =
    exportedSetting?.kind === "array"
      ? exportedSetting.elements.map((readSetting) => readSetting())
      : [exportedSetting];
  const inputs = [];
  for (const configuration of configurations) {
    if (configuration?.kind !== "object") {
      return {
        unresolved: `${name} exports a ${tool} configuration whose effective setting is not a statically known object`,
      };
    }
    for (const path of TOOL_ENTRY_PATHS[tool]) {
      const found = configurationInputs(configuration, path);
      if (!found) {
        return {
          unresolved: `${name} sets ${path.join(".")} to a setting that is not a statically known entry`,
        };
      }
      inputs.push(...found);
    }
  }
  return { inputs };
}

function packageDirectoryOf(fileName) {
  let directory = posix.dirname(fileName);
  while (!isManifestFile(posix.join(directory, "package.json"))) {
    const parent = posix.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return directory;
}

function entryStrings(manifestField) {
  if (typeof manifestField === "string") return [manifestField];
  if (Array.isArray(manifestField)) return manifestField.flatMap(entryStrings);
  if (manifestField && typeof manifestField === "object") {
    return Object.values(manifestField).flatMap(entryStrings);
  }
  return [];
}

function packageEntries(manifest, directory) {
  return [
    ...new Set(
      [
        ...entryStrings(manifest.exports),
        ...ENTRY_FIELDS.flatMap((field) => entryStrings(manifest[field])),
      ]
        .filter((entry) => SCRIPT_ENTRY.test(entry))
        .map((entry) => posix.join(directory, entry))
    ),
  ];
}

function entryPattern(entry) {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u");
}

function commandWords(command) {
  const words = command
    .trim()
    .split(/\s+/u)
    .filter((word) => word && !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  while (COMMAND_PREFIXES.has(words[0])) words.shift();
  return words;
}

function scriptPatternMatches(pattern, name) {
  return pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}

function buildCommands(scripts, name, seen) {
  if (seen.has(name) || typeof scripts[name] !== "string") return [];
  seen.add(name);
  return scripts[name].split(/&&|\|\||;/u).flatMap((command) => {
    const words = commandWords(command);
    if (SCRIPT_RUNNERS.has(words[0])) {
      const rest = words.slice(words[1] === "run" ? 2 : 1);
      while (COMMAND_PREFIXES.has(rest[0])) rest.shift();
      return rest[0] in scripts
        ? buildCommands(scripts, rest[0], seen)
        : [rest];
    }
    if (SCRIPT_SEQUENCERS.has(words[0])) {
      return words
        .slice(1)
        .filter((word) => !word.startsWith("-"))
        .flatMap((pattern) =>
          Object.keys(scripts)
            .filter((script) => scriptPatternMatches(pattern, script))
            .flatMap((script) => buildCommands(scripts, script, seen))
        );
    }
    return [words];
  });
}

function argumentAfterFlag(words, names) {
  const index = words.findIndex((word) => names.includes(word));
  const flagArgument = index >= 0 ? words[index + 1] : undefined;
  return flagArgument && !flagArgument.startsWith("-")
    ? flagArgument
    : undefined;
}

function toolConfigFile(directory, tool, words) {
  const explicit = argumentAfterFlag(words, ["--config", "-c"]);
  if (explicit) return posix.join(directory, explicit);
  return CONFIG_EXTENSIONS.map((extension) =>
    posix.join(directory, `${TOOL_CONFIG_STEMS[tool]}.${extension}`)
  ).find((candidate) => existsSync(candidate));
}

function positionalInputs(words) {
  return words
    .slice(1)
    .filter(
      (word, index, rest) =>
        !word.startsWith("-") &&
        !(index > 0 && rest[index - 1].startsWith("-")) &&
        SCRIPT_ENTRY.test(word)
    )
    .map((input) => ({ input }));
}

function commandBuild(directory, words) {
  const [tool] = words;
  if (tool === "tsc") {
    const projects = words
      .slice(1)
      .filter((word) => !word.startsWith("-") && word.endsWith(".json"));
    const project = argumentAfterFlag(words, ["-p", "--project"]);
    return {
      compilerConfigs: (project ? [project] : projects)
        .concat(project || projects.length ? [] : ["tsconfig.json"])
        .map((config) => posix.join(directory, config)),
      inputs: [],
      issues: [],
    };
  }
  const bundler = tool === "bun" && words[1] === "build" ? "esbuild" : tool;
  const inputs = POSITIONAL_ENTRY_TOOLS.has(bundler)
    ? positionalInputs(bundler === tool ? words : words.slice(1))
    : [];
  const configFile = TOOL_CONFIG_STEMS[bundler]
    ? toolConfigFile(directory, bundler, words)
    : undefined;
  const declared = configFile
    ? declaredBuildInputs(configFile, bundler)
    : { inputs: [] };
  return {
    compilerConfigs: [],
    inputs: inputs.concat(declared.inputs ?? []),
    issues: declared.unresolved ? [declared.unresolved] : [],
  };
}

function declaredBuild(manifest, directory) {
  const commands = buildCommands(manifest.scripts ?? {}, "build", new Set());
  const build = { compilerConfigs: [], inputs: [], issues: [] };
  for (const words of commands) {
    const step = commandBuild(directory, words);
    build.compilerConfigs.push(...step.compilerConfigs);
    build.inputs.push(...step.inputs);
    build.issues.push(...(step.issues ?? []));
  }
  build.inputs.push(
    ...entryStrings(manifest.source).map((input) => ({ input }))
  );
  return build;
}

function outputStem(path) {
  return posix.basename(path).replace(OUTPUT_EXTENSION, "");
}

function entrySources(entry, sources, outputs, inputs, directory) {
  const pattern = entryPattern(entry);
  const direct = sources.filter(
    (sourceFile) =>
      pattern.test(sourceFile.fileName) ||
      pattern.test(sourceFile.fileName.replace(SOURCE_EXTENSION, ""))
  );
  if (direct.length > 0) return direct;
  const compiled = outputs
    .filter(({ name }) => pattern.test(name))
    .map(({ sourceFile }) => sourceFile);
  if (compiled.length > 0) return compiled;
  const stem = outputStem(entry);
  return inputs
    .filter(({ name, input }) => (name ?? outputStem(input)) === stem)
    .flatMap(({ input }) => {
      const inputStem = posix
        .join(directory, input)
        .replace(/\.[cm]?[jt]sx?$/u, "");
      return sources.filter(
        (sourceFile) =>
          sourceFile.fileName.replace(SOURCE_EXTENSION, "") === inputStem
      );
    });
}

function surfaceOf(program, directory) {
  const manifest = JSON.parse(
    readFileSync(posix.join(directory, "package.json"), "utf8")
  );
  const entries = packageEntries(manifest, directory);
  if (entries.length === 0) {
    return { targets: new Set(), unresolved: [], issues: [] };
  }
  const build = declaredBuild(manifest, directory);
  const sources = packageSources(program, directory);
  const outputs = compilerOutputs(sources, build.compilerConfigs);
  const resolved = new Set();
  const unresolved = [];
  for (const entry of entries) {
    const matched = entrySources(
      entry,
      sources,
      outputs,
      build.inputs,
      directory
    );
    if (matched.length === 0) unresolved.push(entry);
    for (const sourceFile of matched) resolved.add(sourceFile);
  }
  return {
    targets: moduleExportTargets(program, resolved),
    unresolved,
    issues: build.issues,
  };
}

export function publicSurface(program, nameNode) {
  const directory = packageDirectoryOf(nameNode.getSourceFile().fileName);
  if (!directory) return {};
  const surfaces = packageSurfaces.get(program) ?? new Map();
  packageSurfaces.set(program, surfaces);
  if (!surfaces.has(directory)) {
    let surface;
    try {
      surface = surfaceOf(program, directory);
    } catch (error) {
      surface = {
        failed: `${posix.join(directory, "package.json")} could not be read as a package build: ${error}`,
      };
    }
    surfaces.set(directory, surface);
  }
  const surface = surfaces.get(directory);
  if (surface.failed) return { incomplete: surface.failed };
  if (surface.targets.has(exportTarget(program, nameNode))) {
    return { owner: "exported from the package entry points" };
  }
  if (surface.unresolved.length === 0) return {};
  const cause =
    surface.issues[0] ?? "the package build declares no input for it";
  return {
    incomplete: `package entry ${posix.relative(directory, surface.unresolved[0])} maps to no source file: ${cause}`,
  };
}
