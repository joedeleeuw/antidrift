import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { isIdentifier } from "./ast.js";

const CALL_DENYLIST = new Set(["createRedisClient", "postgres"]);
const NEW_DENYLIST = new Set([
  "RedisClient",
  "Queue",
  "Worker",
  "S3Client",
  "SQL",
]);
class ModuleResources {
  constructor(context) {
    this.context = context;
    this.functionDepth = 0;
    this.nonStaticClassFieldDepth = 0;
  }
  enterFunction = () => {
    this.functionDepth += 1;
  };

  exitFunction = () => {
    this.functionDepth -= 1;
  };

  enterPropertyDefinition = (node) => {
    if (node.static !== true) {
      this.nonStaticClassFieldDepth += 1;
    }
  };

  exitPropertyDefinition = (node) => {
    if (node.static !== true) {
      this.nonStaticClassFieldDepth -= 1;
    }
  };

  isSuppressed = () =>
    this.functionDepth > 0 || this.nonStaticClassFieldDepth > 0;

  visitCallExpression = (node) => {
    if (this.isSuppressed()) {
      return;
    }
    const callee = node.callee;
    if (
      isIdentifier(callee) &&
      (this.context.options[0]?.factories ?? [...CALL_DENYLIST]).includes(
        callee.name
      )
    ) {
      this.context.report({
        node,
        messageId: "eagerSingleton",
        data: { name: callee.name },
      });
    }
  };

  visitNewExpression = (node) => {
    if (this.isSuppressed()) {
      return;
    }
    const callee = node.callee;
    if (
      isIdentifier(callee) &&
      (this.context.options[0]?.constructors ?? [...NEW_DENYLIST]).includes(
        callee.name
      )
    ) {
      this.context.report({
        node,
        messageId: "eagerSingleton",
        data: { name: `new ${callee.name}` },
      });
    }
  };
  listeners() {
    return {
      FunctionDeclaration: this.enterFunction,
      "FunctionDeclaration:exit": this.exitFunction,
      FunctionExpression: this.enterFunction,
      "FunctionExpression:exit": this.exitFunction,
      ArrowFunctionExpression: this.enterFunction,
      "ArrowFunctionExpression:exit": this.exitFunction,
      PropertyDefinition: this.enterPropertyDefinition,
      "PropertyDefinition:exit": this.exitPropertyDefinition,
      CallExpression: this.visitCallExpression,
      NewExpression: this.visitNewExpression,
    };
  }
}

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
    return new ModuleResources(context).listeners();
  },
};
