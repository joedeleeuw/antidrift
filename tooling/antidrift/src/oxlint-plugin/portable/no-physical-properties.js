import { isClassValue } from "./class-value.js";
import { isRuleFile, scopeProperties } from "./scope.js";
import {
  hasPhysicalProperty,
  replacePhysicalProperties,
} from "./physical-properties.js";

const isClassNameAttribute = (node) =>
  node?.type === "JSXAttribute" &&
  node.name.type === "JSXIdentifier" &&
  node.name.name === "className";
const isDirectClassNameValue = (node) => {
  if (isClassNameAttribute(node.parent) && node.parent.value === node) {
    return true;
  }
  if (
    node.parent?.type === "JSXExpressionContainer" &&
    node.parent.expression === node &&
    isClassNameAttribute(node.parent.parent)
  ) {
    return true;
  }
  if (node.type !== "TemplateElement") {
    return false;
  }
  const template = node.parent;
  const container = template?.parent;
  return (
    template?.type === "TemplateLiteral" &&
    template.quasis.at(0) === node &&
    container?.type === "JSXExpressionContainer" &&
    container.expression === template &&
    isClassNameAttribute(container.parent)
  );
};
function withoutSymmetricInsets(value) {
  return value.replace(/\b(left|right)-([\w.]+)\b/gu, (token, side, size) => {
    const other = side === "left" ? "right" : "left";
    return value.split(/\s+/u).includes(`${other}-${size}`) ? "" : token;
  });
}
const reportPhysicalProperty = (context, node) => {
  if (!isDirectClassNameValue(node)) {
    context.report({ node, messageId: "physicalProperty" });
    return;
  }
  context.report({
    node,
    messageId: "physicalProperty",
    fix: (fixer) => {
      const source = context.sourceCode.getText(node);
      if (
        source.includes("\\") ||
        /&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/iu.test(source)
      ) {
        return null;
      }
      const replacement = replacePhysicalProperties(source);
      return replacement === source
        ? null
        : fixer.replaceText(node, replacement);
    },
  });
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
    fixable: "code",
    messages: {
      physicalProperty:
        "Physical directional CSS property breaks RTL. " +
        "Use logical equivalents: " +
        "ml→ms, mr→me, pl→ps, pr→pe, " +
        "left→start, right→end, " +
        "text-left→text-start, text-right→text-end, " +
        "border-l→border-s, border-r→border-e, " +
        "rounded-l→rounded-s, rounded-r→rounded-e.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      Literal(node) {
        if (!isClassValue(node, context)) return;
        if (typeof node.value !== "string") {
          return;
        }
        if (hasPhysicalProperty(withoutSymmetricInsets(node.value))) {
          reportPhysicalProperty(context, node);
        }
      },
      TemplateElement(node) {
        if (!isClassValue(node, context)) return;
        if (hasPhysicalProperty(withoutSymmetricInsets(node.value.raw))) {
          reportPhysicalProperty(context, node);
        }
      },
    };
  },
};
