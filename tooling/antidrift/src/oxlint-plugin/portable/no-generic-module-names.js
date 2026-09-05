import { isRuleFile, scopeProperties } from "./scope.js";
import { isFixtureOrDocsFile, isTestFilename } from "./syntax.js";

const BANNED_NAMES = new Set([
  "utils",
  "helpers",
  "common",
  "misc",
  "temp",
  "stuff",
  "shared",
  "general",
  "lib",
  "functions",
  "methods",
  "types2",
]);
export const noGenericModuleNamesRule = {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    docs: {
      description: "Disallow generic file names that convey no domain meaning.",
    },
    messages: {
      genericName:
        "File name '{{name}}' is too generic. Use a domain-specific name.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    if (isTestFilename(context.filename)) {
      return {};
    }
    if (isFixtureOrDocsFile(context.filename)) {
      return {};
    }
    return {
      Program(node) {
        const filename = context.filename;
        if (!filename) {
          return;
        }
        const basename = filename.split("/").pop() ?? "";
        const stem = basename.replace(/\.[^.]+$/, "");
        if (!BANNED_NAMES.has(stem)) {
          return;
        }
        context.report({
          node,
          messageId: "genericName",
          data: { name: stem },
        });
      },
    };
  },
};
export default noGenericModuleNamesRule;
