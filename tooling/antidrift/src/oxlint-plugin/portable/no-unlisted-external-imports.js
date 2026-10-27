import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTypeOnlyModule } from "../../semantic-adapters/kernel/syntax-node.ts";
import {
  createUsageResolver,
  governingOptions,
  importedName,
  matchesSpecifierPattern,
  specifierPackage,
} from "../../semantic-adapters/provenance/declared-dependencies.ts";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { packageOwner } from "./package-owner.js";

function unlistedDependencyName({
  node,
  typeOnly,
  filename,
  compilerOptions,
  resolveUsage,
  owner,
  dependencies,
  typeDependencies,
}) {
  const source = node.source.value;
  const acceptedDependencies = typeOnly ? typeDependencies : dependencies;
  const sourceName = specifierPackage(source);
  if (
    sourceName === null ||
    (!source.startsWith("#") && acceptedDependencies.has(sourceName))
  ) {
    return null;
  }
  const resolution = resolveUsage(source, node.source.range[0]);
  if (
    !resolution &&
    (source.startsWith("#") ||
      Object.keys(compilerOptions.paths ?? {}).some((pattern) =>
        matchesSpecifierPattern(source, pattern)
      ))
  ) {
    return null;
  }
  if (!resolution) return sourceName;
  const targetOwner = packageOwner(resolution.resolvedFileName);
  if (owner && targetOwner?.directory === owner.directory) return null;
  if (
    !source.startsWith("#") &&
    resolution.isExternalLibraryImport === false &&
    targetOwner?.manifest.name !== sourceName
  ) {
    return null;
  }
  const targetName = targetOwner?.manifest.name;
  if (source.startsWith("#") && typeof targetName !== "string") {
    throw new Error(
      `Cannot determine the external package owner for '${source}' imported by '${filename}' from '${resolution.resolvedFileName}'.`
    );
  }
  const name = source.startsWith("#") ? importedName(targetName) : sourceName;
  return acceptedDependencies.has(name) ? null : name;
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
    const owner = packageOwner(filename);
    const manifest = owner?.manifest ?? {};
    const dependencies = new Set([
      manifest.name,
      ...[
        manifest.dependencies,
        manifest.devDependencies,
        manifest.peerDependencies,
        manifest.optionalDependencies,
      ].flatMap((group) => Object.keys(group ?? {})),
    ]);
    if (context.options[0]?.ancestorDevDependencies !== false) {
      let current = owner;
      while (current && dirname(current.directory) !== current.directory) {
        current = packageOwner(
          join(dirname(current.directory), "__dependency_probe__.js")
        );
        for (const name of Object.keys(
          current?.manifest.devDependencies ?? {}
        )) {
          dependencies.add(name);
        }
      }
    }
    const typeDependencies = new Set(dependencies);
    for (const dependency of dependencies) {
      if (typeof dependency === "string") {
        typeDependencies.add(importedName(dependency));
      }
    }
    const compilerOptions = governingOptions(dirname(filename));
    const resolveUsage = createUsageResolver(
      filename,
      context.sourceCode.text,
      compilerOptions
    );
    const prefixes = context.options[0]?.internalPrefixes ?? ["@/", "~/"];
    function inspect(node) {
      const source = node.source?.value;
      if (
        typeof source !== "string" ||
        isBuiltin(source) ||
        prefixes.some((prefix) => source.startsWith(prefix))
      ) {
        return;
      }
      const typeOnly = isTypeOnlyModule(node);
      const name = unlistedDependencyName({
        node,
        typeOnly,
        filename,
        compilerOptions,
        resolveUsage,
        owner,
        dependencies,
        typeDependencies,
      });
      if (name === null) return;
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
