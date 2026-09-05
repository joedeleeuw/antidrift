import { isRuleFile, scopeProperties } from "./scope.js";
import { isAstNode } from "./ast.js";

const TRIGGER_NAMES = new Set([
  "AlertDialogTrigger",
  "DialogTrigger",
  "SheetTrigger",
  "PopoverTrigger",
]);
const MENU_ITEM_NAMES = new Set([
  "MenuItem",
  "MenuSubTrigger",
  "ContextMenuItem",
  "DropdownMenuItem",
]);
const jsxElementName = (node) => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxElementName(node.property);
  }
  if (node.type === "JSXNamespacedName") {
    return jsxElementName(node.name);
  }
  return null;
};
const getOpeningElement = (element) => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};
const nameOfJsxElement = (element) =>
  jsxElementName(getOpeningElement(element)?.name);
const getAttribute = (openingElement, name) => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute) =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        jsxElementName(attribute.name) === name,
    ) ?? null
  );
};
const getRenderTarget = (openingElement) => {
  const value = getAttribute(openingElement, "render")?.value;
  if (!isAstNode(value)) {
    return null;
  }
  const expression =
    value.type === "JSXExpressionContainer" ? value.expression : value;
  return isAstNode(expression) && expression.type === "JSXElement"
    ? expression
    : null;
};
const getChildElements = (element) => {
  if (!isAstNode(element) || !Array.isArray(element.children)) {
    return [];
  }
  return element.children.filter(
    (child) => isAstNode(child) && child.type === "JSXElement",
  );
};
const mountsMenuItem = (triggerElement) => {
  const openingElement = getOpeningElement(triggerElement);
  const renderName = nameOfJsxElement(getRenderTarget(openingElement));
  if (renderName !== null && MENU_ITEM_NAMES.has(renderName)) {
    return true;
  }
  return getChildElements(triggerElement).some((child) => {
    const childName = nameOfJsxElement(child);
    return childName !== null && MENU_ITEM_NAMES.has(childName);
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
    messages: {
      triggerInsideMenuItem:
        "Do not mount a dialog trigger inside a menu item; the menu cannot close under the dialog. Lift the dialog beside the menu with `open` state and let the item request it.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      JSXElement(node) {
        const triggerName = nameOfJsxElement(node);
        if (
          triggerName === null ||
          !TRIGGER_NAMES.has(triggerName) ||
          !mountsMenuItem(node)
        ) {
          return;
        }
        context.report({ node, messageId: "triggerInsideMenuItem" });
      },
    };
  },
};
