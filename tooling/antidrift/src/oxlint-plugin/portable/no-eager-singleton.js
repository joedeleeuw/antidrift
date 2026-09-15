import { isRuleFile, scopeProperties } from "./scope.js";
import { isIdentifier } from "./ast.js";

const CALL_DENYLIST = new Set(["createRedisClient", "postgres"]);
const NEW_DENYLIST = new Set([
  "RedisClient",
  "Queue",
  "Worker",
  "S3Client",
  "SQL",
]);
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          constructors: { type: "array", items: { type: "string" } },
          factories: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      eagerSingleton:
        "Construct '{{name}}' in the configured runtime resource owner at startup or first use, rather than module evaluation.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    let functionDepth = 0;
    let nonStaticClassFieldDepth = 0;
    const enterFunction = () => {
      functionDepth += 1;
    };
    const exitFunction = () => {
      functionDepth -= 1;
    };
    const enterPropertyDefinition = (node) => {
      if (node.static !== true) {
        nonStaticClassFieldDepth += 1;
      }
    };
    const exitPropertyDefinition = (node) => {
      if (node.static !== true) {
        nonStaticClassFieldDepth -= 1;
      }
    };
    const isSuppressed = () =>
      functionDepth > 0 || nonStaticClassFieldDepth > 0;
    if (
      (() => {
        functionDepth = 0;
        nonStaticClassFieldDepth = 0;
      })() === false
    ) {
      return {};
    }
    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      PropertyDefinition: enterPropertyDefinition,
      "PropertyDefinition:exit": exitPropertyDefinition,
      CallExpression(node) {
        if (isSuppressed()) {
          return;
        }
        const callee = node.callee;
        if (
          isIdentifier(callee) &&
          (context.options[0]?.factories ?? [...CALL_DENYLIST]).includes(
            callee.name,
          )
        ) {
          context.report({
            node,
            messageId: "eagerSingleton",
            data: { name: callee.name },
          });
        }
      },
      NewExpression(node) {
        if (isSuppressed()) {
          return;
        }
        const callee = node.callee;
        if (
          isIdentifier(callee) &&
          (context.options[0]?.constructors ?? [...NEW_DENYLIST]).includes(
            callee.name,
          )
        ) {
          context.report({
            node,
            messageId: "eagerSingleton",
            data: { name: `new ${callee.name}` },
          });
        }
      },
    };
  },
};
