import { isRuleFile, scopeProperties } from "./scope.js";

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
const isAstNode = (node) =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";
const getJsxName = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return getJsxName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return getJsxName(node.name);
  }
  return null;
};
const getElementName = (element) => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  const openingElement = element.openingElement;
  if (!isAstNode(openingElement)) {
    return null;
  }
  return getJsxName(openingElement.name);
};
const getOpeningElement = (element) => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};
const getAttributes = (openingElement) => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return [];
  }
  return openingElement.attributes;
};
const getAttributeName = (attribute) => {
  if (!isAstNode(attribute) || attribute.type !== "JSXAttribute") {
    return null;
  }
  return getJsxName(attribute.name);
};
const findAttribute = (openingElement, name) =>
  getAttributes(openingElement).find(
    (attribute) => getAttributeName(attribute) === name,
  ) ?? null;
const hasAttribute = (openingElement, names) =>
  getAttributes(openingElement).some((attribute) => {
    const name = getAttributeName(attribute);
    return name !== null && names.has(name);
  });
const getStaticStringValue = (node) => {
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
  const className = findAttribute(openingElement, "className");
  return getStaticStringValue(className?.value) ?? "";
};
const isScreenReaderOnly = (element) => {
  const openingElement = getOpeningElement(element);
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
  const name = getElementName(node);
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
  const openingElement = getOpeningElement(node);
  const name = getJsxName(openingElement?.name);
  if (name !== "Button" && name !== "button") {
    return false;
  }
  const size = findAttribute(openingElement, "size");
  const sizeValue = getStaticStringValue(size?.value);
  if (typeof sizeValue === "string" && sizeValue.startsWith("icon")) {
    return true;
  }
  return getClassName(openingElement)
    .split(/\s+/u)
    .some((className) => /^size-\d/u.test(className));
};
const getRenderElement = (openingElement) => {
  const render = findAttribute(openingElement, "render");
  if (!isAstNode(render)) {
    return null;
  }
  const value = render.value;
  if (!isAstNode(value)) {
    return null;
  }
  if (value.type === "JSXExpressionContainer") {
    return value.expression;
  }
  return value;
};
const hasTooltip = (node) => {
  let current = isAstNode(node) ? node : null;
  while (isAstNode(current)) {
    if (current.type === "JSXElement") {
      const openingElement = getOpeningElement(current);
      const name = getJsxName(openingElement?.name);
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
      const renderElement = getRenderElement(openingElement);
      const renderOpeningElement = getOpeningElement(renderElement);
      if (hasAttribute(renderOpeningElement, TOOLTIP_ATTRS)) {
        return true;
      }
      const renderElementName = getJsxName(renderOpeningElement?.name);
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
  const name = getElementName(node);
  if (name === null || !INTERACTIVE_ELEMENTS.has(name)) {
    return false;
  }
  if (hasVisibleText(node)) {
    return false;
  }
  const openingElement = getOpeningElement(node);
  const renderElement = getRenderElement(openingElement);
  if (isIconSizeButton(renderElement)) {
    return true;
  }
  if (isIconSizeButton(node)) {
    return hasIconChild(node, icons);
  }
  return hasIconChild(node, icons);
};
const filenameOf = (context) =>
  context.filename ?? context.getFilename?.() ?? "";
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
        return filenameOf(context).endsWith(".tsx");
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
          data: { tag: getElementName(node) ?? "control" },
        });
      },
    };
  },
};
