import { isRuleFile, scopeProperties } from "./scope.js";

const WATCHED_HANDLERS = new Set([
  "onMouseDown",
  "onMouseUp",
  "onClick",
  "onContextMenu",
  "onPointerDown",
  "onPointerUp",
  "onFocus",
  "onTouchStart",
  "onTouchEnd",
]);
const PORTAL_POPUPS = new Set([
  "ComboboxPopup",
  "DialogContent",
  "DialogPopup",
  "MenuPopup",
  "PopoverContent",
  "PopoverPanel",
  "PopoverPopup",
  "TooltipPopup",
]);
const INTERACTIVE_ELEMENTS = new Set(["a", "button", "Button", "Link"]);

const HELPER_NAMES = new Set(["containedEventHandler", "containedHandler"]);
const jsxAttrName = (attr) =>
  attr?.name?.type === "JSXIdentifier" && typeof attr.name.name === "string"
    ? attr.name.name
    : null;
const jsxElementName = (node) =>
  node?.type === "JSXIdentifier" && typeof node.name === "string"
    ? node.name
    : null;
const openingHasInteractiveHandler = (opening) =>
  (opening.attributes ?? []).some((attr) => {
    const attrName = jsxAttrName(attr);
    if (attrName === null || !WATCHED_HANDLERS.has(attrName)) {
      return false;
    }
    return !isSafeHandlerValue(expressionFromAttribute(attr));
  });
const interactiveAncestorName = (opening) => {
  let current = opening.parent?.parent;
  while (current && typeof current === "object") {
    if (current.type === "JSXElement") {
      const ancestorOpening = current.openingElement;
      const ancestorName = jsxElementName(ancestorOpening?.name);
      if (
        ancestorName !== null &&
        (INTERACTIVE_ELEMENTS.has(ancestorName) ||
          openingHasInteractiveHandler(ancestorOpening))
      ) {
        return ancestorName;
      }
    }
    current = current.parent;
  }
  return null;
};
const isPlainIdentifier = (node, name) =>
  node?.type === "Identifier" &&
  typeof node.name === "string" &&
  (name === undefined || node.name === name);
const expressionFromAttribute = (attr) => {
  if (!attr || !attr.value) {
    return null;
  }
  if (attr.value.type === "JSXExpressionContainer") {
    return attr.value.expression;
  }
  return null;
};
const isSafeHandlerValue = (expr) => {
  if (!expr) {
    return true;
  }
  if (isPlainIdentifier(expr, "undefined")) {
    return true;
  }
  if (expr.type === "Literal" && expr.value === null) {
    return true;
  }
  if (expr.type === "CallExpression") {
    return isPlainIdentifier(expr.callee) && HELPER_NAMES.has(expr.callee.name);
  }
  if (expr.type === "ConditionalExpression") {
    return (
      isSafeHandlerValue(expr.consequent) && isSafeHandlerValue(expr.alternate)
    );
  }
  if (expr.type === "LogicalExpression") {
    return isSafeHandlerValue(expr.left) && isSafeHandlerValue(expr.right);
  }
  return false;
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
      portalUnderInteractive:
        "`<{{popup}}>` portals its events through the React tree but is " +
        "nested under interactive `<{{ancestor}}>`. Hoist the popup/root " +
        "outside that interactive subtree so popup events cannot trigger " +
        "navigation or parent actions.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      JSXOpeningElement(opening) {
        const popupName = jsxElementName(opening.name);
        if (popupName === null || !PORTAL_POPUPS.has(popupName)) {
          return;
        }
        const ancestorName = interactiveAncestorName(opening);
        if (ancestorName === null) {
          return;
        }
        context.report({
          node: opening,
          messageId: "portalUnderInteractive",
          data: { ancestor: ancestorName, popup: popupName },
        });
      },
    };
  },
};
