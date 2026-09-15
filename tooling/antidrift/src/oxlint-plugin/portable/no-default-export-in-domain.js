import { isRuleFile, scopeProperties } from "./scope.js";
import { isDomainFile, isTestFilename } from "./syntax.js";

export const noDefaultExportInDomainRule = {
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
      description:
        "Disallow default exports in domain modules to enforce explicit named exports.",
    },
    messages: {
      forbidden:
        "Default exports are banned in domain modules. Use named exports.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    if (isTestFilename(context.filename)) {
      return {};
    }
    if (!isDomainFile(context.filename)) {
      return {};
    }
    return {
      ExportDefaultDeclaration(node) {
        context.report({ node, messageId: "forbidden" });
      },
    };
  },
};
export default noDefaultExportInDomainRule;
