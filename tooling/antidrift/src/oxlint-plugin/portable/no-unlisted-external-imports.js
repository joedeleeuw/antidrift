import { isRuleFile, scopeProperties } from "./scope.js";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { packageOwner } from "./package-owner.js";

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
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const owner = packageOwner(context.filename ?? context.getFilename());
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
          join(dirname(current.directory), "__dependency_probe__.js"),
        );
        for (const name of Object.keys(
          current?.manifest.devDependencies ?? {},
        )) {
          dependencies.add(name);
        }
      }
    }
    const prefixes = context.options[0]?.internalPrefixes ?? ["@/", "~/"];
    function inspect(node) {
      const source = node.source?.value;
      if (
        typeof source !== "string" ||
        isBuiltin(source) ||
        source.startsWith(".") ||
        source.startsWith("/") ||
        source.startsWith("#") ||
        prefixes.some((prefix) => source.startsWith(prefix)) ||
        /^[a-z]+:/u.test(source)
      ) {
        return;
      }
      const name = source.startsWith("@")
        ? source.split("/").slice(0, 2).join("/")
        : source.split("/")[0];
      if (!dependencies.has(name)) {
        context.report({ node, messageId: "unlisted", data: { name } });
      }
    }
    return {
      ImportDeclaration: inspect,
      ExportNamedDeclaration: inspect,
      ExportAllDeclaration: inspect,
      ImportExpression: inspect,
    };
  },
};
