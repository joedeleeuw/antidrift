import { isRuleFile, scopeProperties } from "./scope.js";
import { isIdentifier, isStringLiteral, unwrapExpression } from "./ast.js";

const isAstNode = (node) =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const REPLACE_METHODS = new Set(["replace", "replaceAll"]);
const getStaticPropertyName = (node) => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};
const isFunctionExpressionLike = (node) =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression");
const isNoSubstitutionTemplateLiteral = (node) =>
  isAstNode(node) &&
  node.type === "TemplateLiteral" &&
  Array.isArray(node.expressions) &&
  node.expressions.length === 0;
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
      requireFunctionReplacer:
        "Dynamic value passed as the replacement argument of " +
        "'.{{method}}()'. JS interprets '$&', '$$', \"$`\", \"$'\", " +
        "and '$<name>' in replacement strings even for a plain-string " +
        "search, so dynamic content can silently corrupt the output. " +
        "Wrap the replacement in a function: " +
        ".{{method}}(pattern, () => value).",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const resolveVariable = (identifierNode) => {
      if (!isIdentifier(identifierNode)) {
        return null;
      }
      let scope = context.sourceCode.getScope(identifierNode);
      while (scope) {
        const variable = scope.set.get(identifierNode.name);
        if (variable) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    };
    const isFunctionBinding = (identifierNode) => {
      const variable = resolveVariable(identifierNode);
      if (variable === null) {
        return false;
      }
      return variable.defs.some((def) => {
        if (def.type === "FunctionName") {
          return isAstNode(def.node) && def.node.type === "FunctionDeclaration";
        }
        if (def.type !== "Variable" || !isAstNode(def.node)) {
          return false;
        }
        if (def.node.type !== "VariableDeclarator") {
          return false;
        }
        if (
          !isAstNode(def.parent) ||
          def.parent.type !== "VariableDeclaration" ||
          def.parent.kind === "var"
        ) {
          return false;
        }
        return isFunctionExpressionLike(unwrapExpression(def.node.init));
      });
    };
    const isAllowedReplacement = (argument) => {
      if (
        argument?.type === "TaggedTemplateExpression" &&
        argument.tag.type === "MemberExpression" &&
        isIdentifier(argument.tag.object, "String") &&
        isIdentifier(argument.tag.property, "raw") &&
        !resolveVariable(argument.tag.object)?.defs.length &&
        isNoSubstitutionTemplateLiteral(argument.quasi)
      ) {
        return true;
      }
      if (isFunctionExpressionLike(argument)) {
        return true;
      }
      if (isStringLiteral(argument)) {
        return true;
      }
      if (isNoSubstitutionTemplateLiteral(argument)) {
        return true;
      }
      if (isIdentifier(argument)) {
        return isFunctionBinding(argument);
      }
      return false;
    };
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (!isAstNode(callee) || callee.type !== "MemberExpression") {
          return;
        }
        const method = getStaticPropertyName(callee.property);
        if (method === null || !REPLACE_METHODS.has(method)) {
          return;
        }
        if (node.arguments.length !== 2) {
          return;
        }
        const [pattern, replacement] = node.arguments;
        if (
          !isAstNode(pattern) ||
          pattern.type === "SpreadElement" ||
          !isAstNode(replacement) ||
          replacement.type === "SpreadElement"
        ) {
          return;
        }
        const unwrappedReplacement = unwrapExpression(replacement);
        if (
          isAstNode(unwrappedReplacement) &&
          unwrappedReplacement.type === "ObjectExpression"
        ) {
          return;
        }
        if (isAllowedReplacement(unwrappedReplacement)) {
          return;
        }
        context.report({
          node: replacement,
          messageId: "requireFunctionReplacer",
          data: { method },
        });
      },
    };
  },
};
