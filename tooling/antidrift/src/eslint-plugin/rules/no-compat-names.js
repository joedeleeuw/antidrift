import {
  isRuleFile,
  scopeProperties,
} from "../../oxlint-plugin/portable/scope.js";

const REMOVAL_VOCABULARY =
  /legacy|compat(?!ible)|deprecated|retire|no_?longer/i;

function parameterIdentifier(node) {
  if (node.type === "TSParameterProperty") {
    return parameterIdentifier(node.parameter);
  }
  if (node.type === "AssignmentPattern") return node.left;
  return node;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declared names that preserve a compatibility, legacy, deprecated, or retired path.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      compatName:
        "'{{name}}' declares a compatibility or retirement path. Delete the old path instead of keeping or naming it.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    function check(node) {
      if (node?.type === "Identifier" && REMOVAL_VOCABULARY.test(node.name)) {
        context.report({
          node,
          messageId: "compatName",
          data: { name: node.name },
        });
      }
    }
    function checkFunction(node) {
      if (node.type === "FunctionDeclaration") check(node.id);
      for (const parameter of node.params) {
        check(parameterIdentifier(parameter));
      }
    }
    function checkKey(node) {
      if (!node.computed) check(node.key);
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      VariableDeclarator(node) {
        check(node.id);
      },
      ClassDeclaration(node) {
        check(node.id);
      },
      TSInterfaceDeclaration(node) {
        check(node.id);
      },
      TSTypeAliasDeclaration(node) {
        check(node.id);
      },
      MethodDefinition: checkKey,
      TSAbstractMethodDefinition: checkKey,
      PropertyDefinition: checkKey,
      TSAbstractPropertyDefinition: checkKey,
      TSPropertySignature: checkKey,
    };
  },
};
