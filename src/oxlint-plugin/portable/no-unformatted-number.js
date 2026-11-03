import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { resolvedTypeTexts } from "../shared/type-services.js";

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
  segments(name).some((specifier) => NUMERIC_WORDS.has(specifier));
const NUMERIC_TYPE_TEXT = /^(?:number\b|-?\d)/u;
const STRING_TYPE_TEXT = /^(?:string\b|["'`])/u;
const isProvablyString = (node, sourceCode) => {
  const typeTexts = resolvedTypeTexts(node, sourceCode);
  return (
    typeTexts !== null &&
    !typeTexts.some((typeText) => NUMERIC_TYPE_TEXT.test(typeText)) &&
    typeTexts.some((typeText) => STRING_TYPE_TEXT.test(typeText))
  );
};
const isNumericExpr = (node, sourceCode) => {
  if (!node || isProvablyString(node, sourceCode)) {
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
const isStringCall = (node, sourceCode) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "String" &&
  isNumericExpr(node.arguments[0], sourceCode);
const isNumericTemplate = (node, sourceCode) =>
  node.type === "TemplateLiteral" &&
  node.expressions.some((expression) => isNumericExpr(expression, sourceCode));
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
            (attribute) => attribute.name?.name === "data-testid"
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
        const sourceCode = context.sourceCode;
        if (
          isStringCall(expr, sourceCode) ||
          isNumericTemplate(expr, sourceCode) ||
          (isTextChild && isNumericExpr(expr, sourceCode))
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
