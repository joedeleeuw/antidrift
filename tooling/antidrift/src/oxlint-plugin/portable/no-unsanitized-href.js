import { importedOwner, importedOwnerSchema } from "./imported-owner.js";
import { isRuleFile, scopeProperties } from "./scope.js";
import { isIdentifier } from "./ast.js";

const SAFE_HREF_PREFIXES = ["https://", "http://", "/", "#", "mailto:"];
const isSafeStringLiteral = (node) => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return SAFE_HREF_PREFIXES.some((prefix) => node.value.startsWith(prefix));
  }
  return false;
};
const isSafeTemplateLiteral = (node) => {
  if (node.type !== "TemplateLiteral") {
    return false;
  }
  const firstQuasi = node.quasis[0];
  if (!firstQuasi) {
    return false;
  }
  return SAFE_HREF_PREFIXES.some((prefix) =>
    firstQuasi.value.raw.startsWith(prefix),
  );
};

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: { ...scopeProperties, sanitizers: importedOwnerSchema },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      unsanitizedHref:
        "Sanitize dynamic href values through the imported URL-policy owner registered in sanitizers at the anchor " +
        "sink to prevent javascript: XSS. Static http(s), mailto, " +
        "fragment, and relative literals are allowed.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "href") {
          return;
        }
        const opening = node.parent;
        if (opening.type !== "JSXOpeningElement") {
          return;
        }
        const tag = opening.name;
        if (tag.type !== "JSXIdentifier" || tag.name !== "a") {
          return;
        }
        if (!node.value) {
          return;
        }
        if (node.value.type === "Literal") {
          if (isSafeStringLiteral(node.value)) {
            return;
          }
          context.report({
            node,
            messageId: "unsanitizedHref",
          });
          return;
        }
        if (node.value.type !== "JSXExpressionContainer") {
          return;
        }
        const expr = node.value.expression;
        if (isSafeStringLiteral(expr)) {
          return;
        }
        if (isSafeTemplateLiteral(expr)) {
          return;
        }
        if (
          expr.type === "CallExpression" &&
          importedOwner(
            context,
            expr.callee,
            context.options[0]?.sanitizers ?? [],
          )
        ) {
          return;
        }
        if (isIdentifier(expr, "undefined")) {
          return;
        }
        if (expr.type === "Literal" && expr.value === null) {
          return;
        }
        context.report({ node, messageId: "unsanitizedHref" });
      },
    };
  },
};
