import {
  isRuleFile,
  scopeProperties,
} from "../../oxlint-plugin/shared/rule-scope.js";
import { unwrapExpression } from "../shared/scope.js";

const REMOVAL_VOCABULARY =
  /legacy|compat(?!ible)|deprecated|retire|no_?longer/i;
const SNAKE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const CAMEL_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;

function isSnakeCamelAliasPair(leftKey, rightKey) {
  const leftSnake = SNAKE_KEY_PATTERN.test(leftKey);
  const rightSnake = SNAKE_KEY_PATTERN.test(rightKey);
  if (leftSnake === rightSnake) return false;
  const camelCandidate = leftSnake ? rightKey : leftKey;
  if (!CAMEL_KEY_PATTERN.test(camelCandidate)) return false;
  return (
    leftKey.replaceAll("_", "").toLowerCase() ===
    rightKey.replaceAll("_", "").toLowerCase()
  );
}

function checkDualKeyAliasRead(node, context) {
  if (node.operator !== "??" && node.operator !== "||") return;
  const left = unwrapExpression(node.left);
  const right = unwrapExpression(node.right);
  if (
    left?.type !== "MemberExpression" ||
    right?.type !== "MemberExpression" ||
    left.computed ||
    right.computed ||
    left.property?.type !== "Identifier" ||
    right.property?.type !== "Identifier"
  ) {
    return;
  }
  const leftKey = left.property.name;
  const rightKey = right.property.name;
  if (!isSnakeCamelAliasPair(leftKey, rightKey)) return;
  const leftReceiver = context.sourceCode
    .getText(left.object)
    .replace(/\s+/gu, "");
  const rightReceiver = context.sourceCode
    .getText(right.object)
    .replace(/\s+/gu, "");
  if (leftReceiver !== rightReceiver) return;
  context.report({
    node,
    message: `Dual-key read '${leftReceiver}.${leftKey} ${node.operator} ${rightReceiver}.${rightKey}' probes both snake_case and camelCase spellings on the same receiver; normalize once at the boundary schema and read one canonical property.`,
  });
}

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
      LogicalExpression(node) {
        checkDualKeyAliasRead(node, context);
      },
    };
  },
};
