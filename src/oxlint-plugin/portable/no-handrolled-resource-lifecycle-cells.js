import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

function isUseStateCall(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type !== "CallExpression") return false;
  const callee = unwrapExpression(unwrapped.callee);
  return (
    (callee?.type === "Identifier" && callee.name === "useState") ||
    (callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "React" &&
      callee.property?.type === "Identifier" &&
      callee.property.name === "useState")
  );
}

function isAbortOrRequestGuardNode(node) {
  let found = false;
  function visit(current) {
    if (found || !current || typeof current !== "object") return;
    if (
      current.type === "Identifier" &&
      (current.name === "AbortController" ||
        current.name === "signal" ||
        current.name === "aborted" ||
        current.name === "cancelled" ||
        current.name === "canceled")
    ) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(node);
  return found;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          threshold: { type: "number" },
          shardThreshold: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const sourceCode = context.sourceCode;
    const setterVariables = new Set();
    const fnStack = [];

    function enterFunction(node) {
      fnStack.push({
        node,
        isAsync: Boolean(node.async),
        hasAwait: false,
        hasCatch: false,
        booleanSetterToggledTrue: new Set(),
        booleanSetterToggledFalse: new Set(),
        errorSetterCalledInCatch: new Set(),
        resourceSetterCalled: new Set(),
      });
    }

    function exitFunction() {
      const frame = fnStack.pop();
      if (!frame) return;
      if (!frame.isAsync && !frame.hasAwait) return;
      if (isAbortOrRequestGuardNode(frame.node)) return;
      const toggledBool = [...frame.booleanSetterToggledTrue].some((v) =>
        frame.booleanSetterToggledFalse.has(v)
      );
      if (
        toggledBool &&
        frame.errorSetterCalledInCatch.size > 0 &&
        frame.resourceSetterCalled.size > 0
      ) {
        context.report({
          node: frame.node,
          message:
            "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
        });
      }
    }

    function insideCatch(node) {
      for (let current = node.parent; current; current = current.parent) {
        if (current.type === "CatchClause") return true;
        if (isFunctionLike(current)) return false;
      }
      return false;
    }

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      VariableDeclarator(node) {
        if (
          node.id?.type === "ArrayPattern" &&
          node.id.elements.length >= 2 &&
          node.id.elements[1]?.type === "Identifier" &&
          isUseStateCall(node.init)
        ) {
          const v = findVariable(sourceCode, node.id.elements[1]);
          if (v) setterVariables.add(v);
        }
      },
      AwaitExpression() {
        const frame = fnStack.at(-1);
        if (frame) frame.hasAwait = true;
      },
      CatchClause() {
        const frame = fnStack.at(-1);
        if (frame) frame.hasCatch = true;
      },
      CallExpression(node) {
        const frame = fnStack.at(-1);
        if (!frame || node.callee?.type !== "Identifier") return;
        const variable = findVariable(sourceCode, node.callee);
        if (!variable || !setterVariables.has(variable)) return;
        const arg = unwrapExpression(node.arguments[0]);
        if (arg?.type === "Literal" && typeof arg.value === "boolean") {
          if (arg.value) {
            frame.booleanSetterToggledTrue.add(variable);
          } else {
            frame.booleanSetterToggledFalse.add(variable);
          }
          return;
        }
        if (insideCatch(node)) {
          frame.errorSetterCalledInCatch.add(variable);
          return;
        }
        if (arg && !(arg.type === "Literal" && arg.value === null)) {
          frame.resourceSetterCalled.add(variable);
        }
      },
    };
  },
};
