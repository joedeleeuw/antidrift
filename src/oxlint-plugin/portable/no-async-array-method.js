import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const REQUIRE_COLLECTION = new Set(["map", "flatMap"]);
const NEVER_AWAIT = new Set([
  "filter",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "sort",
]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);

function isPromiseCombinatorCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "Promise" &&
    node.callee.property?.type === "Identifier" &&
    PROMISE_COMBINATORS.has(node.callee.property.name)
  );
}

function isWrappedInPromiseCombinator(node) {
  let current = node.parent;
  while (
    current &&
    (current.type === "ChainExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.parent;
  }
  return isPromiseCombinatorCall(current);
}

function isReturnedExpression(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "ReturnStatement") return true;
    if (current.type === "ArrowFunctionExpression" && current.body === node) {
      return true;
    }
    if (isFunctionLike(current) || current.type === "BlockStatement") {
      return false;
    }
  }
  return false;
}

function enabledBranches(option) {
  const branches = option?.branches;
  if (branches === undefined) {
    return new Set(["never-await", "requires-collection"]);
  }
  if (
    !Array.isArray(branches) ||
    branches.some((branch) => typeof branch !== "string")
  ) {
    throw new TypeError("async-array branches must be strings");
  }
  return new Set(["never-await", ...branches]);
}

class AsyncArrayCallbacks {
  constructor(context) {
    this.context = context;
    this.sourceCode = this.context.sourceCode;
    this.pendingMaps = [];
    this.branches = enabledBranches(this.context.options[0]);
  }
  visitProgramExit = () => {
    for (const pending of this.pendingMaps) {
      if (!pending.awaited && !pending.returned) {
        this.context.report({
          node: pending.node,
          message: `Wrap .${pending.method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`,
        });
      }
    }
  };

  visitReturnStatement = (node) => {
    const arg = unwrapExpression(node.argument);
    if (arg?.type === "Identifier") {
      const binding = findVariable(this.sourceCode, arg);
      for (const pending of this.pendingMaps) {
        if (pending.variable && pending.variable === binding) {
          pending.returned = true;
        }
      }
    }
  };

  visitCallExpression = (node) => {
    if (isPromiseCombinatorCall(node)) {
      const firstArg = unwrapExpression(node.arguments[0]);
      if (firstArg?.type === "Identifier") {
        const binding = findVariable(this.sourceCode, firstArg);
        for (const pending of this.pendingMaps) {
          if (pending.variable && pending.variable === binding) {
            pending.awaited = true;
          }
        }
      }
    }
    const callee = unwrapExpression(node.callee);
    if (
      callee?.type !== "MemberExpression" ||
      callee.computed ||
      callee.property?.type !== "Identifier"
    ) {
      return;
    }
    const method = callee.property.name;
    const callback = unwrapExpression(node.arguments[0]);
    if (!isFunctionLike(callback) || !callback.async) return;

    if (NEVER_AWAIT.has(method)) {
      if (!this.branches.has("never-await")) return;
      this.context.report({
        node: callback,
        message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.`,
      });
      return;
    }
    this.inspectCollection(node, callback, method);
  };

  inspectCollection = (node, callback, method) => {
    if (
      !REQUIRE_COLLECTION.has(method) ||
      !this.branches.has("requires-collection")
    ) {
      return;
    }
    if (isWrappedInPromiseCombinator(node) || isReturnedExpression(node)) {
      return;
    }
    const parent = node.parent;
    if (
      parent?.type === "VariableDeclarator" &&
      parent.id?.type === "Identifier"
    ) {
      const binding = findVariable(this.sourceCode, parent.id);
      if (binding) {
        this.pendingMaps.push({
          variable: binding,
          node: callback,
          method,
          awaited: false,
          returned: false,
        });
        return;
      }
    }
    this.context.report({
      node: callback,
      message: `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`,
    });
  };
  listeners() {
    return {
      "Program:exit": this.visitProgramExit,
      ReturnStatement: this.visitReturnStatement,
      CallExpression: this.visitCallExpression,
    };
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...scopeProperties,
          branches: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: ["never-await", "requires-collection"] },
          },
        },
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new AsyncArrayCallbacks(context).listeners();
  },
};
