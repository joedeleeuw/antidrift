import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  jsxChildElements,
  jsxOpeningElement,
  jsxRenderElement,
  nameOfJsxElement,
} from "./ast.js";

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
const mountsMenuItem = (triggerElement) => {
  const renderName = nameOfJsxElement(
    jsxRenderElement(jsxOpeningElement(triggerElement))
  );
  if (renderName !== null && MENU_ITEM_NAMES.has(renderName)) {
    return true;
  }
  return jsxChildElements(triggerElement).some((child) => {
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
