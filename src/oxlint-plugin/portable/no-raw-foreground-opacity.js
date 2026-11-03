import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";

const TEXT_FOREGROUND_OPACITY_PATTERN =
  /(?:^|:)(?:text|decoration|bg|border|ring)-(?:muted-foreground|foreground)\/(?:40|45|50|60|64|70|72|80)(?:\b|$)/;
const findRawForegroundOpacity = (classNames) => {
  for (const token of classNames.split(/\s+/)) {
    if (TEXT_FOREGROUND_OPACITY_PATTERN.test(token)) {
      return token;
    }
  }
  return undefined;
};
function checkClassNames(context, node, classNames) {
  const match = findRawForegroundOpacity(classNames);
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
        checkClassNames(context, node, node.value);
      },
      TemplateElement(node) {
        checkClassNames(context, node, node.value.raw);
      },
    };
  },
};
