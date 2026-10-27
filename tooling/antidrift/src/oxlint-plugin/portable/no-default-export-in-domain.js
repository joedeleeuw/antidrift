import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { isDomainFile, isMigrationFile, isTestFilename } from "./syntax.js";

const GENERATED_MODULE_PATTERN = /\.(?:gen|generated)\.[cm]?[jt]sx?$/;
const DECLARATION_MODULE_PATTERN = /\.d\.[cm]?ts$/;

const noDefaultExportInDomainRule = {
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
    if (
      !isRuleFile(context, isDomainFile) ||
      isTestFilename(context.filename) ||
      isMigrationFile(context.filename) ||
      GENERATED_MODULE_PATTERN.test(context.filename) ||
      DECLARATION_MODULE_PATTERN.test(context.filename)
    ) {
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
