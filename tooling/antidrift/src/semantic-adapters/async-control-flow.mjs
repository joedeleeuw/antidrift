export const ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION = new Set([
  "map",
  "flatMap",
]);

export const ASYNC_ARRAY_METHODS_NEVER_AWAIT = new Set([
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

export const PROMISE_COMBINATOR_METHODS = new Set([
  "all",
  "allSettled",
  "race",
]);

export function isPromiseCombinator(callee) {
  return (
    callee?.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Promise" &&
    callee.property?.type === "Identifier" &&
    PROMISE_COMBINATOR_METHODS.has(callee.property.name)
  );
}

export function getDeclaredVariable(sourceCode, declarator) {
  if (declarator.id?.type !== "Identifier") return null;
  return (
    sourceCode.scopeManager
      ?.getDeclaredVariables(declarator)
      .find((variable) => variable.name === declarator.id.name) ?? null
  );
}

export function findVariable(sourceCode, identifier) {
  if (
    identifier?.type !== "Identifier" ||
    typeof sourceCode.getScope !== "function"
  ) {
    return null;
  }
  let scope = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set?.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

export function promiseCombinatorVariables(sourceCode, node) {
  if (!isPromiseCombinator(node.callee)) return [];
  return node.arguments.flatMap((arg) => {
    if (arg.type === "Identifier") {
      const variable = findVariable(sourceCode, arg);
      return variable ? [variable] : [];
    }
    if (arg.type === "SpreadElement" && arg.argument.type === "Identifier") {
      const variable = findVariable(sourceCode, arg.argument);
      return variable ? [variable] : [];
    }
    return [];
  });
}

export function asyncCallbackArgument(node) {
  const callback = node.arguments?.[0];
  return (callback?.type === "ArrowFunctionExpression" ||
    callback?.type === "FunctionExpression") &&
    callback.async === true
    ? callback
    : null;
}

export function asyncArrayCallbackClassification(node) {
  const callee = node.callee;
  if (
    callee?.type !== "MemberExpression" ||
    callee.property?.type !== "Identifier"
  ) {
    return null;
  }
  const method = callee.property.name;
  const callback = asyncCallbackArgument(node);
  if (!callback) return null;
  if (ASYNC_ARRAY_METHODS_NEVER_AWAIT.has(method)) {
    return { callback, method, kind: "never-await" };
  }
  if (ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION.has(method)) {
    return { callback, method, kind: "requires-collection" };
  }
  return null;
}

export function markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps) {
  const variables = promiseCombinatorVariables(sourceCode, node);
  for (const variable of variables) {
    for (const pending of pendingAsyncMaps) {
      if (pending.variable === variable) pending.awaited = true;
    }
  }
}

function transparentReturnExpression(node, child) {
  if (
    node?.type === "ConditionalExpression" &&
    (node.consequent === child || node.alternate === child)
  ) {
    return true;
  }
  if (
    node?.type === "LogicalExpression" &&
    (node.left === child || node.right === child)
  ) {
    return true;
  }
  if (node?.type === "SequenceExpression") {
    return node.expressions?.at(-1) === child;
  }
  return (
    (node?.type === "ChainExpression" ||
      node?.type === "TSAsExpression" ||
      node?.type === "TSTypeAssertion" ||
      node?.type === "TSNonNullExpression") &&
    node.expression === child
  );
}

export function isDirectlyWrappedInPromiseCombinator(node) {
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    isPromiseCombinator(parent.callee) &&
    parent.arguments.includes(node)
  );
}

export function isReturnedExpression(node) {
  let current = node;
  let parent = current?.parent;
  while (parent) {
    if (parent.type === "ReturnStatement") return parent.argument === current;
    if (parent.type === "ArrowFunctionExpression") return parent.body === current;
    if (!transparentReturnExpression(parent, current)) return false;
    current = parent;
    parent = current.parent;
  }
  return false;
}

function returnedCollectionVariables(sourceCode, expression) {
  if (!expression) return [];
  if (expression.type === "Identifier") {
    const variable = findVariable(sourceCode, expression);
    return variable ? [variable] : [];
  }
  if (expression.type === "ConditionalExpression") {
    return [
      ...returnedCollectionVariables(sourceCode, expression.consequent),
      ...returnedCollectionVariables(sourceCode, expression.alternate),
    ];
  }
  if (expression.type === "LogicalExpression") {
    return [
      ...returnedCollectionVariables(sourceCode, expression.left),
      ...returnedCollectionVariables(sourceCode, expression.right),
    ];
  }
  if (expression.type === "SequenceExpression") {
    return returnedCollectionVariables(sourceCode, expression.expressions?.at(-1));
  }
  if (
    expression.type === "ChainExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSTypeAssertion" ||
    expression.type === "TSNonNullExpression"
  ) {
    return returnedCollectionVariables(sourceCode, expression.expression);
  }
  return [];
}

export function markReturnedPendingMaps(sourceCode, node, pendingAsyncMaps) {
  const expression = node?.type === "ReturnStatement" ? node.argument : node;
  const variables = returnedCollectionVariables(sourceCode, expression);
  for (const variable of variables) {
    for (const pending of pendingAsyncMaps) {
      if (pending.variable === variable) pending.returned = true;
    }
  }
}

export function queuePendingAsyncMap(
  sourceCode,
  node,
  callback,
  method,
  pendingAsyncMaps,
) {
  const parent = node.parent;
  if (parent?.type !== "VariableDeclarator") return false;
  const variable = getDeclaredVariable(sourceCode, parent);
  if (!variable) return false;
  pendingAsyncMaps.push({
    variable,
    node: callback,
    method,
    awaited: false,
    returned: false,
  });
  return true;
}
