import { mergeVisitors } from "../../semantic-adapters/kernel/merge-visitors.mjs";
import { silentEmptyDetectionVisitors } from "./absence-fallback/silent-empty-detection.js";

const sentinelValues = new Set([
  "unknown",
  "n/a",
  "none",
  "unavailable",
  "error",
  "missing",
]);

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function sentinelValue(node) {
  const expression = unwrapExpression(node);
  if (!expression) return "";
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return sentinelValues.has(expression.value.toLowerCase())
      ? expression.value
      : "";
  }
  if (
    expression.type === "TemplateLiteral" &&
    expression.expressions.length === 0 &&
    expression.quasis.length === 1
  ) {
    const cooked = expression.quasis[0].value.cooked;
    return typeof cooked === "string" &&
      sentinelValues.has(cooked.toLowerCase())
      ? cooked
      : "";
  }
  return "";
}

export default function ruleNoSentinelAbsenceFallback() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Keep missing member values and detection failures distinct from real values.",
      },
      schema: [
        {
          type: "object",
          properties: { memberSentinels: { type: "boolean" } },
          additionalProperties: false,
        },
      ],
      messages: {
        sentinelAbsenceFallback:
          'This fallback hides a missing member behind "{{sentinel}}". Keep the missing value distinct from a reported value.',
        noSilentEmptyFallback:
          "Do not return an empty string from {{name}} (source: {{source}}). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
      },
    },
    create(context) {
      const memberSentinels = context.options[0]?.memberSentinels !== false;
      return mergeVisitors(
        memberSentinels
          ? {
              LogicalExpression(node) {
                if (node.operator !== "??") return;
                if (unwrapExpression(node.left)?.type !== "MemberExpression") {
                  return;
                }
                const sentinel = sentinelValue(node.right);
                if (!sentinel) return;
                context.report({
                  node,
                  messageId: "sentinelAbsenceFallback",
                  data: { sentinel },
                });
              },
            }
          : {},
        silentEmptyDetectionVisitors(context)
      );
    },
  };
}
