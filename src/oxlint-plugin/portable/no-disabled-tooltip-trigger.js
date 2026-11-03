import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  filenameForContext,
  jsxAttribute,
  jsxOpeningElement,
  jsxRenderElement,
  nameOfJsxElement,
} from "./ast.js";

const TOOLTIP_ELEMENTS = new Set(["Tooltip", "TooltipRoot", "TooltipTrigger"]);
const MAX_RENDER_DEPTH = 8;
const triggersDisabledButton = (tooltipElement) => {
  let element = jsxRenderElement(jsxOpeningElement(tooltipElement));
  for (
    let depth = 0;
    element !== null && depth < MAX_RENDER_DEPTH;
    depth += 1
  ) {
    const openingElement = jsxOpeningElement(element);
    if (
      nameOfJsxElement(element) === "Button" &&
      jsxAttribute(openingElement, "disabled") !== null
    ) {
      return true;
    }
    element = jsxRenderElement(openingElement);
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
      unreachableTooltip:
        "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    if (!filenameForContext(context).endsWith(".tsx")) {
      return {};
    }
    return {
      JSXElement(node) {
        const name = nameOfJsxElement(node);
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
