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

const transparentParents = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.name;
  }
  return "";
}

function isConsoleCall(callee) {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console"
  );
}

// Text shown to a person (interpolated, concatenated, rendered as a JSX child,
// stringified or logged) cannot be mistaken for a stored value, so a
// placeholder there is formatting, not an absence sentinel.
function isDisplayText(node) {
  let current = node;
  let parent = current.parent;
  while (
    transparentParents.has(parent?.type) ||
    (parent?.type === "ConditionalExpression" && parent.test !== current)
  ) {
    current = parent;
    parent = current.parent;
  }
  switch (parent?.type) {
    case "TemplateLiteral":
      return true;
    case "BinaryExpression":
      return parent.operator === "+";
    case "JSXExpressionContainer":
      return (
        parent.parent?.type === "JSXElement" ||
        parent.parent?.type === "JSXFragment"
      );
    case "CallExpression": {
      if (parent.callee === current) return false;
      const name = calleeName(parent.callee);
      return (
        name === "String" ||
        isConsoleCall(parent.callee) ||
        (name === "createElement" && parent.arguments.indexOf(current) >= 2)
      );
    }
    default:
      return false;
  }
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
          if (!sentinel || isDisplayText(node)) return;
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
