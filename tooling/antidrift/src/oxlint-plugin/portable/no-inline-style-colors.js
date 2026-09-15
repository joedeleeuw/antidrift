import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isAstNode, unwrapExpression } from "./ast.js";

const HEX_IN_STRING = /#[0-9a-f]{3,8}\b/i;
const COLOR_FUNC_IN_STRING = /\b(?:rgb|rgba|hsl|hsla)\s*\(/i;
const NAMED_COLOR_PATTERN = /\b(?:white|black|red|blue|green|gray|grey)\b/i;
const CSS_PROP_FALSE_POSITIVES = /\bwhite-space\b/gi;
function isSafe(value) {
  if (value.startsWith("var(")) {
    return true;
  }
  const lower = value.toLowerCase().trim();
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
function stripVarExpressions(value) {
  let result = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === "v" && value.slice(i, i + 4) === "var(") {
      let depth = 1;
      i += 4;
      while (i < value.length && depth > 0) {
        if (value[i] === "(") {
          depth++;
        } else if (value[i] === ")") {
          depth--;
        }
        i++;
      }
    } else {
      result += value[i];
      i++;
    }
  }
  return result;
}
function containsHardcodedColor(value) {
  if (isSafe(value)) {
    return null;
  }
  const stripped = stripVarExpressions(value);
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
function getStaticStyleValue(value) {
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type !== "TemplateLiteral" || value.expressions.length > 0) {
    return undefined;
  }
  const quasi = value.quasis.at(0);
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

    const checkStyleObject = (styleObject) => {
      for (const property of styleObject.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const value = property.value;
        const staticValue = getStaticStyleValue(value);
        if (staticValue === undefined) {
          continue;
        }
        const match = containsHardcodedColor(staticValue);
        if (match === null) {
          continue;
        }
        context.report({
          node: value,
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
          checkStyleObject(expression);
        }
      },
    };
  },
};
