import { classValueVisitors } from "./class-value.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const SPLIT = /[\s"'`{}()]+/;
const baseClass = (token) => {
  const idx = token.lastIndexOf(":");
  return idx === -1 ? token : token.slice(idx + 1);
};
const isVerticalScroll = (className) =>
  className === "overflow-auto" ||
  className === "overflow-scroll" ||
  className === "overflow-y-auto" ||
  className === "overflow-y-scroll";
const constrainsWidth = (className) =>
  className.startsWith("max-w-") &&
  className !== "max-w-none" &&
  className !== "max-w-full";
const isCenteredScrollColumn = (classNames) => {
  const classes = classNames.split(SPLIT).filter(Boolean).map(baseClass);
  const hasScroll = classes.some(isVerticalScroll);
  const hasCenter = classes.includes("mx-auto");
  const hasMaxW = classes.some(constrainsWidth);
  if (!(hasScroll && hasCenter && hasMaxW)) {
    return false;
  }
  const exempt = classes.some(
    (className) =>
      className === "absolute" ||
      className === "fixed" ||
      className.startsWith("max-h-")
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

    return classValueVisitors(context, (node, classNames) => {
      if (isCenteredScrollColumn(classNames)) {
        context.report({ node, messageId: "centeredScrollColumn" });
      }
    });
  },
};
