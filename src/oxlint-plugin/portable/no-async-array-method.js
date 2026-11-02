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
    const sourceCode = context.sourceCode;
    const pendingMaps = [];
    const branches = enabledBranches(context.options[0]);

    return {
      "Program:exit"() {
        for (const pending of pendingMaps) {
          if (!pending.awaited && !pending.returned) {
            context.report({
              node: pending.node,
              message: `Wrap .${pending.method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`,
            });
          }
        }
      },
      ReturnStatement(node) {
        const arg = unwrapExpression(node.argument);
        if (arg?.type === "Identifier") {
          const variable = findVariable(sourceCode, arg);
          for (const pending of pendingMaps) {
            if (pending.variable && pending.variable === variable) {
              pending.returned = true;
            }
          }
        }
      },
      CallExpression(node) {
        if (isPromiseCombinatorCall(node)) {
          const firstArg = unwrapExpression(node.arguments[0]);
          if (firstArg?.type === "Identifier") {
            const variable = findVariable(sourceCode, firstArg);
            for (const pending of pendingMaps) {
              if (pending.variable && pending.variable === variable) {
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
          if (!branches.has("never-await")) return;
          context.report({
            node: callback,
            message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.`,
          });
          return;
        }
        if (
          !REQUIRE_COLLECTION.has(method) ||
          !branches.has("requires-collection")
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
          const variable = findVariable(sourceCode, parent.id);
          if (variable) {
            pendingMaps.push({
              variable,
              node: callback,
              method,
              awaited: false,
              returned: false,
            });
            return;
          }
        }
        context.report({
          node: callback,
          message: `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`,
        });
      },
    };
  },
};
