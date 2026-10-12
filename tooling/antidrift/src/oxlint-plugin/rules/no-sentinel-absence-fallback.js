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

function climbTransparent(node) {
  let current = node;
  while (
    transparentParents.has(current.parent?.type) ||
    (current.parent?.type === "ConditionalExpression" &&
      current.parent.test !== current)
  ) {
    current = current.parent;
  }
  return current;
}

// Interpolation, concatenation and String() only compose text; they establish
// nothing about where the text goes.
function composedText(node) {
  const parent = node.parent;
  if (parent?.type === "TemplateLiteral") return parent;
  if (parent?.type === "BinaryExpression" && parent.operator === "+") {
    return parent;
  }
  if (
    parent?.type === "CallExpression" &&
    parent.callee !== node &&
    calleeName(parent.callee) === "String"
  ) {
    return parent;
  }
  return null;
}

// Text shown to a person (rendered as a JSX or createElement child, or
// logged to the console), directly or through the text it is composed into,
// cannot be mistaken for a stored value, so a placeholder there is formatting,
// not an absence sentinel.
function isDisplayText(node) {
  let current = climbTransparent(node);
  for (let composed = composedText(current); composed; ) {
    current = climbTransparent(composed);
    composed = composedText(current);
  }
  const parent = current.parent;
  switch (parent?.type) {
    case "JSXExpressionContainer":
      return (
        parent.parent?.type === "JSXElement" ||
        parent.parent?.type === "JSXFragment"
      );
    case "CallExpression":
      return (
        parent.callee !== current &&
        (isConsoleCall(parent.callee) ||
          (calleeName(parent.callee) === "createElement" &&
            parent.arguments.indexOf(current) >= 2))
      );
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
