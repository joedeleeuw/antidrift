import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { unwrapExpression } from "../shared/scope.js";
import { getPropertyName, isAstNode } from "./ast.js";

const HEX_IN_STRING = /#[0-9a-f]{3,8}\b/i;
const COLOR_FUNC_IN_STRING = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;
const NAMED_COLOR_PATTERN = /\b(?:white|black|red|blue|green|gray|grey)\b/i;
const CSS_PROP_FALSE_POSITIVES = /\bwhite-space\b/gi;
function isSafe(cssText) {
  if (cssText.startsWith("var(")) {
    return true;
  }
  const lower = cssText.toLowerCase().trim();
  if (
    lower === "transparent" ||
    lower === "inherit" ||
    lower === "currentcolor" ||
    lower === "unset" ||
    lower === "initial" ||
    lower === "none" ||
    lower === "auto"
  ) {
    return true;
  }
  return false;
}
function stripVarExpressions(cssText) {
  let strippedCss = "";
  let i = 0;
  while (i < cssText.length) {
    if (cssText[i] === "v" && cssText.slice(i, i + 4) === "var(") {
      let depth = 1;
      i += 4;
      while (i < cssText.length && depth > 0) {
        if (cssText[i] === "(") {
          depth++;
        } else if (cssText[i] === ")") {
          depth--;
        }
        i++;
      }
    } else {
      strippedCss += cssText[i];
      i++;
    }
  }
  return strippedCss;
}
function containsHardcodedColor(cssText) {
  if (isSafe(cssText)) {
    return null;
  }
  const stripped = stripVarExpressions(cssText);
  const hexMatch = HEX_IN_STRING.exec(stripped);
  if (hexMatch) {
    return hexMatch[0];
  }
  const funcMatch = COLOR_FUNC_IN_STRING.exec(stripped);
  if (funcMatch) {
    return funcMatch[0];
  }
  const sanitized = stripped.replace(CSS_PROP_FALSE_POSITIVES, "");
  const namedMatch = NAMED_COLOR_PATTERN.exec(sanitized);
  if (namedMatch) {
    return namedMatch[0];
  }
  return null;
}
function getStaticStyleText(expression) {
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (
    expression.type !== "TemplateLiteral" ||
    expression.expressions.length > 0
  ) {
    return undefined;
  }
  const quasi = expression.quasis.at(0);
  return quasi?.value.cooked ?? quasi?.value.raw;
}
const isObjectExpression = (node) =>
  isAstNode(node) && node.type === "ObjectExpression";
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
      inlineColor:
        "Hardcoded color '{{match}}' in '{{prop}}' breaks dark mode. " +
        "Use a CSS variable or Tailwind class instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const checkStyleProperties = (styleExpression) => {
      for (const property of styleExpression.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const initializer = property.value;
        const staticCss = getStaticStyleText(initializer);
        if (staticCss === undefined) {
          continue;
        }
        const match = containsHardcodedColor(staticCss);
        if (match === null) {
          continue;
        }
        context.report({
          node: initializer,
          messageId: "inlineColor",
          data: {
            match,
            prop: getPropertyName(property.key) ?? "?",
          },
        });
      }
    };
    return {
      JSXAttribute(node) {
        if (
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== "style" ||
          node.value?.type !== "JSXExpressionContainer"
        ) {
          return;
        }
        const expression = unwrapExpression(node.value.expression);
        if (isObjectExpression(expression)) {
          checkStyleProperties(expression);
        }
      },
    };
  },
};
