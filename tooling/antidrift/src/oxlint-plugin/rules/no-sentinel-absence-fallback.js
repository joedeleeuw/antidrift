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
    return typeof cooked === "string" && sentinelValues.has(cooked.toLowerCase())
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
          "Disallow nullish-coalescing a member read to an in-band absence sentinel string",
      },
      schema: [],
      messages: {
        sentinelAbsenceFallback:
          'Do not coerce a missing member value to the "{{sentinel}}" sentinel: absence becomes indistinguishable from a real value. Model absence as absence — an optional field, null, or a parsed enum with an explicit unavailable member.',
      },
    },
    create(context) {
      return {
        LogicalExpression(node) {
          if (node.operator !== "??") return;
          if (unwrapExpression(node.left)?.type !== "MemberExpression") return;
          const sentinel = sentinelValue(node.right);
          if (!sentinel) return;
          context.report({
            node,
            messageId: "sentinelAbsenceFallback",
            data: { sentinel },
          });
        },
      };
    },
  };
}
