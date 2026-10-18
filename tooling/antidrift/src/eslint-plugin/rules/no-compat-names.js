import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";

const REMOVAL_VOCABULARY =
  /legacy|compat(?!ible)|deprecated|retire|no_?longer/i;

function* patternIdentifiers(node) {
  switch (node?.type) {
    case "Identifier":
      yield node;
      return;
    case "AssignmentPattern":
      yield* patternIdentifiers(node.left);
      return;
    case "RestElement":
      yield* patternIdentifiers(node.argument);
      return;
    case "ArrayPattern":
      for (const element of node.elements) yield* patternIdentifiers(element);
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        yield* patternIdentifiers(
          property.type === "RestElement" ? property : property.value
        );
      }
      return;
    case "TSParameterProperty":
      yield* patternIdentifiers(node.parameter);
      return;
    default:
  }
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
    function checkPattern(pattern) {
      for (const identifier of patternIdentifiers(pattern)) check(identifier);
    }
    function checkFunction(node) {
      if (node.type === "FunctionDeclaration") check(node.id);
      for (const parameter of node.params) {
        checkPattern(parameter);
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
        checkPattern(node.id);
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
