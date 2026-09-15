import { isClassValue } from "./class-value.js";
import { isRuleFile, scopeProperties } from "./scope.js";

const SPLIT = /[\s"'`{}()]+/;
const baseClass = (token) => {
  const idx = token.lastIndexOf(":");
  return idx === -1 ? token : token.slice(idx + 1);
};
const isVerticalScroll = (c) =>
  c === "overflow-auto" ||
  c === "overflow-scroll" ||
  c === "overflow-y-auto" ||
  c === "overflow-y-scroll";
const constrainsWidth = (c) =>
  c.startsWith("max-w-") && c !== "max-w-none" && c !== "max-w-full";
const isCenteredScrollColumn = (value) => {
  const classes = value.split(SPLIT).filter(Boolean).map(baseClass);
  const hasScroll = classes.some(isVerticalScroll);
  const hasCenter = classes.includes("mx-auto");
  const hasMaxW = classes.some(constrainsWidth);
  if (!(hasScroll && hasCenter && hasMaxW)) {
    return false;
  }
  const exempt = classes.some(
    (c) => c === "absolute" || c === "fixed" || c.startsWith("max-h-"),
  );
  return !exempt;
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
      centeredScrollColumn:
        "Centered, width-capped column owns the vertical scroll " +
        "(mx-auto + max-w-* + overflow-y-auto/scroll), so the scrollbar " +
        "floats at the column edge instead of the pane edge next to the " +
        "inspector rail. Move overflow to a full-width parent " +
        "(e.g. flex-1 overflow-y-auto) and keep mx-auto/max-w-* on an " +
        "inner content wrapper. (absolute/fixed/max-h-* boxes are exempt.)",
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
        if (isCenteredScrollColumn(node.value)) {
          context.report({ node, messageId: "centeredScrollColumn" });
        }
      },
      TemplateElement(node) {
        if (!isClassValue(node, context)) return;
        if (isCenteredScrollColumn(node.value.raw)) {
          context.report({ node, messageId: "centeredScrollColumn" });
        }
      },
    };
  },
};
