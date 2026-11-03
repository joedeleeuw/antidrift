import { mergeVisitors } from "../shared/merge-visitors.js";
import { silentEmptyDetectionVisitors } from "./absence-fallback/silent-empty-detection.js";

const sentinelLiterals = new Set([
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

function isZeroLiteral(node) {
  const expr = unwrapExpression(node);
  return expr?.type === "Literal" && expr.value === 0;
}

function hasOptionalChain(node) {
  const expr = unwrapExpression(node);
  if (!expr) return false;
  if (expr.type === "ChainExpression") return true;
  if (expr.type === "MemberExpression" || expr.type === "CallExpression") {
    return (
      Boolean(expr.optional) || hasOptionalChain(expr.object ?? expr.callee)
    );
  }
  return false;
}

function matchedSentinelLiteral(node) {
  const expression = unwrapExpression(node);
  if (!expression) return "";
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return sentinelLiterals.has(expression.value.toLowerCase())
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
      sentinelLiterals.has(cooked.toLowerCase())
      ? cooked
      : "";
  }
  return "";
}

function createSentinelVisitors(context, memberSentinels) {
  return mergeVisitors(
    memberSentinels
      ? {
          LogicalExpression(node) {
            if (node.operator !== "??") return;
            if (unwrapExpression(node.left)?.type !== "MemberExpression") {
              return;
            }
            const sentinel = matchedSentinelLiteral(node.right);
            if (!sentinel) return;
            context.report({
              node,
              messageId: "sentinelAbsenceFallback",
              data: { sentinel },
            });
          },
        }
      : {},
    {
      BinaryExpression(node) {
        if (node.operator !== "!==" && node.operator !== "!=") return;
        const leftChain =
          hasOptionalChain(node.left) && isZeroLiteral(node.right);
        const rightChain =
          hasOptionalChain(node.right) && isZeroLiteral(node.left);
        if (leftChain || rightChain) {
          context.report({
            node,
            messageId: "optionalChainZeroInequality",
          });
        }
      },
    },
    silentEmptyDetectionVisitors(context)
  );
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
        optionalChainZeroInequality:
          "Optional-chain inequality against 0 evaluates to true when the chain short-circuits to undefined; use `(x?.length ?? 0) > 0` instead.",
        sentinelAbsenceFallback:
          'This fallback hides a missing member behind "{{sentinel}}". Keep the missing value distinct from a reported value.',
        noSilentEmptyFallback:
          "Do not return an empty string from {{name}} (source: {{source}}). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
      },
    },
    create(context) {
      const memberSentinels = context.options[0]?.memberSentinels !== false;
      return createSentinelVisitors(context, memberSentinels);
    },
  };
}
