import { isRuleFile, scopeProperties } from "./scope.js";

const NUMERIC_WORDS = new Set([
  "count",
  "gpu",
  "total",
  "subtotal",
  "amount",
  "sum",
  "quantity",
  "qty",
  "hour",
  "hours",
  "minute",
  "minutes",
  "second",
  "seconds",
  "price",
  "balance",
  "score",
]);
const NON_DISPLAY_ATTRS = new Set([
  "key",
  "id",
  "htmlFor",
  "className",
  "style",
  "type",
  "role",
  "name",
  "slot",
  "form",
  "dir",
]);
const segments = (name) =>
  name
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/);
const isNumericName = (name) =>
  segments(name).some((s) => NUMERIC_WORDS.has(s));
const isNumericExpr = (node) => {
  if (!node) {
    return false;
  }
  if (node.type === "Identifier") {
    return isNumericName(node.name);
  }
  if (
    (node.type === "MemberExpression" ||
      node.type === "OptionalMemberExpression") &&
    node.property.type === "Identifier"
  ) {
    return node.property.name === "length" || isNumericName(node.property.name);
  }
  return false;
};
const isStringCall = (node) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "String" &&
  isNumericExpr(node.arguments[0]);
const isNumericTemplate = (node) =>
  node.type === "TemplateLiteral" && node.expressions.some(isNumericExpr);
const inNonDisplayAttr = (node) =>
  node.parent?.type === "JSXAttribute" &&
  node.parent.name?.type === "JSXIdentifier" &&
  NON_DISPLAY_ATTRS.has(node.parent.name.name);
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          formatter: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      unformatted:
        "Format displayed numbers with {{formatter}} so the selected locale controls digits and grouping.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      JSXExpressionContainer(node) {
        const opening = node.parent?.openingElement;
        if (
          /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(context.filename) &&
          opening?.name?.name === "output" &&
          opening.attributes.some(
            (attribute) => attribute.name?.name === "data-testid",
          )
        ) {
          return;
        }
        if (inNonDisplayAttr(node)) {
          return;
        }
        const expr = node.expression;
        const isTextChild =
          node.parent?.type === "JSXElement" ||
          node.parent?.type === "JSXFragment";
        if (
          isStringCall(expr) ||
          isNumericTemplate(expr) ||
          (isTextChild && isNumericExpr(expr))
        ) {
          context.report({
            node,
            messageId: "unformatted",
            data: {
              formatter:
                context.options[0]?.formatter ??
                "Intl.NumberFormat(locale).format(value)",
            },
          });
        }
      },
    };
  },
};
