import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  filenameForContext,
  isAstNode,
  jsxAttribute,
  jsxAttributeName,
  jsxAttributes,
  jsxElementName,
  jsxOpeningElement,
  jsxRenderElement,
  nameOfJsxElement,
} from "./ast.js";

const INTERACTIVE_ELEMENTS = new Set([
  "AlertDialogClose",
  "AlertDialogTrigger",
  "Button",
  "DialogClose",
  "DialogTrigger",
  "MenuTrigger",
  "PopoverTrigger",
  "SheetClose",
  "SheetTrigger",
  "button",
]);
const TOOLTIP_ELEMENTS = new Set(["Tooltip", "TooltipRoot"]);
const TOOLTIP_ATTRS = new Set(["tooltip"]);
const AUTO_TOOLTIP_ELEMENTS = new Set([
  "AlertDialogClose",
  "AlertDialogTrigger",
  "Button",
  "DialogClose",
  "DialogTrigger",
  "MenuTrigger",
  "PopoverTrigger",
  "SheetClose",
  "SheetTrigger",
]);
const AUTO_TOOLTIP_ATTRS = new Set(["aria-label", "title"]);
const NATIVE_TOOLTIP_ATTRS = new Set(["title"]);
const hasAttribute = (openingElement, names) =>
  jsxAttributes(openingElement).some((attribute) => {
    const name = jsxAttributeName(attribute);
    return name !== null && names.has(name);
  });
const getStaticText = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "JSXExpressionContainer" &&
    isAstNode(node.expression) &&
    node.expression.type === "Literal" &&
    typeof node.expression.value === "string"
  ) {
    return node.expression.value;
  }
  return null;
};
const getClassName = (openingElement) => {
  const className = jsxAttribute(openingElement, "className");
  return getStaticText(className?.value) ?? "";
};
const isScreenReaderOnly = (element) => {
  const openingElement = jsxOpeningElement(element);
  return getClassName(openingElement).split(/\s+/u).includes("sr-only");
};
const isLikelyIconExpression = (node) => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    return /(?:^|[a-z])(?:icon|mark)$/iu.test(node.name);
  }
  if (
    node.type !== "MemberExpression" &&
    node.type !== "OptionalMemberExpression"
  ) {
    return false;
  }
  const property = node.property;
  return (
    isAstNode(property) &&
    property.type === "Identifier" &&
    typeof property.name === "string" &&
    /(?:^|[a-z])(?:icon|mark)$/iu.test(property.name)
  );
};
const hasVisibleText = (node) => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "JSXText") {
    return typeof node.value === "string" && /\p{L}|\p{N}/u.test(node.value);
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" && /\p{L}|\p{N}/u.test(node.value);
  }
  if (node.type === "CallExpression" || node.type === "TemplateLiteral") {
    return true;
  }
  if (node.type === "Identifier" || node.type === "MemberExpression") {
    return !isLikelyIconExpression(node);
  }
  if (node.type === "ConditionalExpression") {
    return hasVisibleText(node.consequent) || hasVisibleText(node.alternate);
  }
  if (node.type === "LogicalExpression") {
    return hasVisibleText(node.right);
  }
  if (node.type === "BinaryExpression") {
    return true;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return hasVisibleText(node.expression);
  }
  if (node.type === "JSXExpressionContainer") {
    return hasVisibleText(node.expression);
  }
  if (node.type !== "JSXElement" || isScreenReaderOnly(node)) {
    return false;
  }
  const children = Array.isArray(node.children) ? node.children : [];
  return children.some(hasVisibleText);
};
const isIconElement = (node, icons) => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return false;
  }
  const name = nameOfJsxElement(node);
  if (name === null) {
    return false;
  }
  return (
    name === "svg" ||
    name === "DirectionalIcon" ||
    icons.has(name) ||
    name.endsWith("Icon")
  );
};
const hasIconChild = (node, icons) => {
  if (!isAstNode(node) || node.type !== "JSXElement") {
    return false;
  }
  const children = Array.isArray(node.children) ? node.children : [];
  return children.some((child) => {
    if (isIconElement(child, icons)) {
      return true;
    }
    if (!isAstNode(child) || child.type !== "JSXExpressionContainer") {
      return false;
    }
    return isIconElement(child.expression, icons);
  });
};
const isIconSizeButton = (node) => {
  const openingElement = jsxOpeningElement(node);
  const name = jsxElementName(openingElement?.name);
  if (name !== "Button" && name !== "button") {
    return false;
  }
  const size = jsxAttribute(openingElement, "size");
  const sizeName = getStaticText(size?.value);
  if (typeof sizeName === "string" && sizeName.startsWith("icon")) {
    return true;
  }
  return getClassName(openingElement)
    .split(/\s+/u)
    .some((className) => /^size-\d/u.test(className));
};
const hasTooltip = (node) => {
  let current = isAstNode(node) ? node : null;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const openingElement = jsxOpeningElement(current);
      const name = jsxElementName(openingElement?.name);
      if (name !== null && TOOLTIP_ELEMENTS.has(name)) {
        return true;
      }
      if (hasAttribute(openingElement, TOOLTIP_ATTRS)) {
        return true;
      }
      if (
        name !== null &&
        AUTO_TOOLTIP_ELEMENTS.has(name) &&
        hasAttribute(openingElement, AUTO_TOOLTIP_ATTRS)
      ) {
        return true;
      }
      if (
        name === "button" &&
        hasAttribute(openingElement, NATIVE_TOOLTIP_ATTRS)
      ) {
        return true;
      }
      const renderElement = jsxRenderElement(openingElement);
      const renderOpeningElement = jsxOpeningElement(renderElement);
      if (hasAttribute(renderOpeningElement, TOOLTIP_ATTRS)) {
        return true;
      }
      const renderElementName = jsxElementName(renderOpeningElement?.name);
      if (
        renderElementName !== null &&
        AUTO_TOOLTIP_ELEMENTS.has(renderElementName) &&
        hasAttribute(renderOpeningElement, AUTO_TOOLTIP_ATTRS)
      ) {
        return true;
      }
      if (
        renderElementName === "button" &&
        hasAttribute(renderOpeningElement, NATIVE_TOOLTIP_ATTRS)
      ) {
        return true;
      }
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return false;
};
const isIconOnlyInteractive = (node, icons) => {
  const name = nameOfJsxElement(node);
  if (name === null || !INTERACTIVE_ELEMENTS.has(name)) {
    return false;
  }
  if (hasVisibleText(node)) {
    return false;
  }
  const openingElement = jsxOpeningElement(node);
  const renderElement = jsxRenderElement(openingElement);
  if (isIconSizeButton(renderElement)) {
    return true;
  }
  if (isIconSizeButton(node)) {
    return hasIconChild(node, icons);
  }
  return hasIconChild(node, icons);
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          iconComponents: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      missingTooltip:
        "Icon-only {{tag}} needs a tooltip. Wrap it in <Tooltip> with content, or use a component-level tooltip prop.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const icons = new Set(context.options[0]?.iconComponents ?? []);

    if (
      (() => {
        return filenameForContext(context).endsWith(".tsx");
      })() === false
    ) {
      return {};
    }
    return {
      JSXElement(node) {
        if (!isIconOnlyInteractive(node, icons) || hasTooltip(node)) {
          return;
        }
        context.report({
          node,
          messageId: "missingTooltip",
          data: { tag: nameOfJsxElement(node) ?? "control" },
        });
      },
    };
  },
};
