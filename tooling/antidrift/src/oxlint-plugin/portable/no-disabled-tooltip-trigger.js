import { isRuleFile, scopeProperties } from "./scope.js";

const TOOLTIP_ELEMENTS = new Set(["Tooltip", "TooltipRoot", "TooltipTrigger"]);
const MAX_RENDER_DEPTH = 8;
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
const getOpeningElement = (element) => {
  if (!isAstNode(element) || element.type !== "JSXElement") {
    return null;
  }
  return isAstNode(element.openingElement) ? element.openingElement : null;
};
const getAttribute = (openingElement, name) => {
  if (!isAstNode(openingElement) || !Array.isArray(openingElement.attributes)) {
    return null;
  }
  return (
    openingElement.attributes.find(
      (attribute) =>
        isAstNode(attribute) &&
        attribute.type === "JSXAttribute" &&
        getJsxName(attribute.name) === name,
    ) ?? null
  );
};
const getRenderElement = (openingElement) => {
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
const triggersDisabledButton = (tooltipElement) => {
  let element = getRenderElement(getOpeningElement(tooltipElement));
  for (
    let depth = 0;
    element !== null && depth < MAX_RENDER_DEPTH;
    depth += 1
  ) {
    const openingElement = getOpeningElement(element);
    if (
      getJsxName(openingElement?.name) === "Button" &&
      getAttribute(openingElement, "disabled") !== null
    ) {
      return true;
    }
    element = getRenderElement(openingElement);
  }
  return false;
};
const filenameOf = (context) =>
  context.filename ?? context.getFilename?.() ?? "";
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
      unreachableTooltip:
        "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    if (
      (() => {
        return filenameOf(context).endsWith(".tsx");
      })() === false
    ) {
      return {};
    }
    return {
      JSXElement(node) {
        const name = getJsxName(getOpeningElement(node)?.name);
        if (
          name === null ||
          !TOOLTIP_ELEMENTS.has(name) ||
          !triggersDisabledButton(node)
        ) {
          return;
        }
        context.report({ node, messageId: "unreachableTooltip" });
      },
    };
  },
};
