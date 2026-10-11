import { isRuleFile, scopeProperties } from "./scope.js";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

function isEmptyCollection(node) {
  return (
    (node?.type === "ArrayExpression" && node.elements.length === 0) ||
    (node?.type === "ObjectExpression" && node.properties.length === 0)
  );
}

function enclosingCatch(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTION_TYPES.has(current.type)) return null;
    if (current.type === "CatchClause") return current;
  }
  return null;
}

function isPromiseCatchHandler(node) {
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === node &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.property.name === "catch"
  );
}

function rethrows(body, sourceCode) {
  const pending = [body];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.type === "ThrowStatement") return true;
    for (const key of sourceCode.visitorKeys[current.type] ?? []) {
      for (const child of [current[key]].flat()) {
        if (child?.type && !FUNCTION_TYPES.has(child.type)) pending.push(child);
      }
    }
  }
  return false;
}

function isSilent(handler, sourceCode) {
  return (
    sourceCode
      .getDeclaredVariables(handler)
      .every((variable) => variable.references.length === 0) &&
    !rethrows(handler.body, sourceCode)
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow returning an empty array or object from a failure path that drops the error.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      fallback:
        "Failure path drops the error and returns an empty collection, which makes bad data look valid. Let the error propagate or return a typed failure.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const { sourceCode } = context;

    return {
      ReturnStatement(node) {
        if (!isEmptyCollection(node.argument)) return;
        const handler = enclosingCatch(node);
        if (handler && isSilent(handler, sourceCode)) {
          context.report({ node, messageId: "fallback" });
        }
      },
      ArrowFunctionExpression(node) {
        if (
          isEmptyCollection(node.body) &&
          isPromiseCatchHandler(node) &&
          isSilent(node, sourceCode)
        ) {
          context.report({ node, messageId: "fallback" });
        }
      },
    };
  },
};
