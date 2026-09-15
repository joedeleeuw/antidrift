import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isAstNode, isIdentifier } from "./ast.js";

const LOGGER_IDENTIFIER = "logger";
const LOGGER_METHODS = new Set(["debug", "error", "info", "warn"]);
export const SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN =
  /(?:body|content|email|fileName|message|name|title|password|secret|credential|authorization|cookie|bearer|api[_-]?key|prompt(?!_?token)|snippet|subject|phone)/iu;
const isLoggerCall = (node) => {
  const callee = node.callee;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object, LOGGER_IDENTIFIER) &&
    isIdentifier(callee.property) &&
    LOGGER_METHODS.has(callee.property.name)
  );
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      redactedKey:
        "Log attribute `{{key}}` matches the logger's sensitive-key " +
        "denylist, so the sanitizer drops it and the record ships " +
        "without it. Rename the key (for example `queue` instead of " +
        "`queueName`), or leave the value out if it is a payload.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        if (!isLoggerCall(node)) {
          return;
        }
        const attributes = node.arguments.at(1);
        if (
          !isAstNode(attributes) ||
          attributes.type !== "ObjectExpression" ||
          !Array.isArray(attributes.properties)
        ) {
          return;
        }
        for (const property of attributes.properties) {
          if (
            !isAstNode(property) ||
            property.type !== "Property" ||
            property.computed
          ) {
            continue;
          }
          const key = getPropertyName(property.key);
          if (key === null || !SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN.test(key)) {
            continue;
          }
          context.report({
            node: property,
            messageId: "redactedKey",
            data: { key },
          });
        }
      },
    };
  },
};
