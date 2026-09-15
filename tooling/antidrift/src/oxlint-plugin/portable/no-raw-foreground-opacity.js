import { isRuleFile, scopeProperties } from "./scope.js";

const TEXT_FOREGROUND_OPACITY_PATTERN =
  /(?:^|:)(?:text|decoration|bg|border|ring)-(?:muted-foreground|foreground)\/(?:40|45|50|60|64|70|72|80)(?:\b|$)/;
const findRawForegroundOpacity = (value) => {
  for (const token of value.split(/\s+/)) {
    if (TEXT_FOREGROUND_OPACITY_PATTERN.test(token)) {
      return token;
    }
  }
  return undefined;
};
function checkValue(context, node, value) {
  const match = findRawForegroundOpacity(value);
  if (!match) {
    return;
  }
  context.report({
    node,
    messageId: "rawForegroundOpacity",
    data: { match },
  });
}
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
      rawForegroundOpacity:
        "Raw foreground opacity '{{match}}' hides visual intent. " +
        "Use a named token such as text-foreground-muted, " +
        "text-foreground-placeholder, border-foreground-disabled, " +
        "or text-foreground-strong-muted.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        checkValue(context, node, node.value);
      },
      TemplateElement(node) {
        checkValue(context, node, node.value.raw);
      },
    };
  },
};
