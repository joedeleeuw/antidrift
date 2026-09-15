import { isRuleFile, scopeProperties } from "./scope.js";
import { dirname, resolve, relative } from "node:path";
import { packageOwner } from "./package-owner.js";

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      crossPackage:
        "Import '{{source}}' through the destination package's public entrypoint; {{owner}} owns these files; declare the shared contract in that package before importing it.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const filename = context.filename ?? context.getFilename();
    const owner = packageOwner(filename);
    function inspect(node) {
      const source = node.source?.value;
      if (!owner || typeof source !== "string" || !source.startsWith(".")) {
        return;
      }
      const destination = packageOwner(resolve(dirname(filename), source));
      if (
        destination &&
        destination.directory !== owner.directory &&
        relative(destination.directory, owner.directory).startsWith("..")
      ) {
        context.report({
          node,
          messageId: "crossPackage",
          data: {
            source,
            owner: destination.manifest.name ?? destination.directory,
          },
        });
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
