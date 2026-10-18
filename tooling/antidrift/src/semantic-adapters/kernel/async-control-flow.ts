import type { SyntaxNode } from "./syntax-node.ts";
import {
  identifierName,
  isSyntaxNode,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  syntaxText,
} from "./syntax-node.ts";
import {
  declaredVariables,
  resolveVariable,
  variableName,
} from "./syntax-scope.ts";

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

export type AsyncArrayCallbackClassification = {
  readonly callback: SyntaxNode;
  readonly method: string;
  readonly kind: "never-await" | "requires-collection";
};

export type PendingAsyncMap = {
  readonly variable: unknown;
  readonly node: unknown;
  readonly method: string;
  awaited: boolean;
  returned: boolean;
};

function wrappedOperand(expression: SyntaxNode): readonly unknown[] {
  return [syntaxField(expression, "expression")];
}

const RETURN_TRANSPARENT_OPERANDS = new Map<
  string,
  (expression: SyntaxNode) => readonly unknown[]
>([
  [
    "ConditionalExpression",
    (expression) => [
      syntaxField(expression, "consequent"),
      syntaxField(expression, "alternate"),
    ],
  ],
  [
    "LogicalExpression",
    (expression) => [
      syntaxField(expression, "left"),
      syntaxField(expression, "right"),
    ],
  ],
  [
    "SequenceExpression",
    (expression) => [syntaxChildren(expression, "expressions").at(-1)],
  ],
  ["ChainExpression", wrappedOperand],
  ["TSAsExpression", wrappedOperand],
  ["TSTypeAssertion", wrappedOperand],
  ["TSNonNullExpression", wrappedOperand],
]);

function returnTransparentOperands(expression: SyntaxNode): readonly unknown[] {
  return RETURN_TRANSPARENT_OPERANDS.get(expression.type)?.(expression) ?? [];
}

export function isPromiseCombinator(callee: unknown): boolean {
  if (
    !isSyntaxType(callee, "MemberExpression") ||
    identifierName(syntaxField(callee, "object")) !== "Promise"
  ) {
    return false;
  }
  const method = identifierName(syntaxField(callee, "property"));
  return method !== null && PROMISE_COMBINATOR_METHODS.has(method);
}

export function getDeclaredVariable(sourceCode: unknown, declarator: unknown) {
  const name = identifierName(syntaxField(declarator, "id"));
  if (name === null || !isSyntaxNode(declarator)) {
    return null;
  }
  const scopeManager: unknown =
    typeof sourceCode === "object" && sourceCode !== null
      ? Reflect.get(sourceCode, "scopeManager")
      : undefined;
  return (
    declaredVariables(scopeManager, declarator).find(
      (binding) => variableName(binding) === name
    ) ?? null
  );
}

export function findVariable(sourceCode: unknown, identifier: unknown) {
  if (!isSyntaxType(identifier, "Identifier")) {
    return null;
  }
  const name = syntaxText(identifier, "name");
  return name === null ? null : resolveVariable(sourceCode, identifier, name);
}

export function promiseCombinatorVariables(
  sourceCode: unknown,
  node: unknown
): unknown[] {
  if (!isPromiseCombinator(syntaxField(node, "callee"))) {
    return [];
  }
  return syntaxChildren(node, "arguments").flatMap((argument) => {
    const reference = isSyntaxType(argument, "SpreadElement")
      ? syntaxField(argument, "argument")
      : argument;
    const binding = findVariable(sourceCode, reference);
    return binding ? [binding] : [];
  });
}

export function asyncCallbackArgument(node: unknown): SyntaxNode | null {
  const [callback] = syntaxChildren(node, "arguments");
  return (isSyntaxType(callback, "ArrowFunctionExpression") ||
    isSyntaxType(callback, "FunctionExpression")) &&
    syntaxField(callback, "async") === true
    ? callback
    : null;
}

export function asyncArrayCallbackClassification(
  node: unknown
): AsyncArrayCallbackClassification | null {
  const callee = syntaxField(node, "callee");
  const method = isSyntaxType(callee, "MemberExpression")
    ? identifierName(syntaxField(callee, "property"))
    : null;
  const callback = asyncCallbackArgument(node);
  if (method === null || !callback) {
    return null;
  }
  if (ASYNC_ARRAY_METHODS_NEVER_AWAIT.has(method)) {
    return { callback, method, kind: "never-await" };
  }
  if (ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION.has(method)) {
    return { callback, method, kind: "requires-collection" };
  }
  return null;
}

export function markAwaitedPendingMaps(
  sourceCode: unknown,
  node: unknown,
  pendingAsyncMaps: PendingAsyncMap[]
): void {
  for (const binding of promiseCombinatorVariables(sourceCode, node)) {
    for (const pending of pendingAsyncMaps) {
      if (pending.variable === binding) {
        pending.awaited = true;
      }
    }
  }
}

export function isDirectlyWrappedInPromiseCombinator(node: unknown): boolean {
  const parent = syntaxField(node, "parent");
  return (
    isSyntaxType(parent, "CallExpression") &&
    isPromiseCombinator(syntaxField(parent, "callee")) &&
    syntaxChildren(parent, "arguments").includes(node)
  );
}

export function isReturnedExpression(node: unknown): boolean {
  let current = node;
  let parent = syntaxField(current, "parent");
  while (isSyntaxNode(parent)) {
    if (parent.type === "ReturnStatement") {
      return syntaxField(parent, "argument") === current;
    }
    if (parent.type === "ArrowFunctionExpression") {
      return syntaxField(parent, "body") === current;
    }
    if (!returnTransparentOperands(parent).includes(current)) {
      return false;
    }
    current = parent;
    parent = syntaxField(current, "parent");
  }
  return false;
}

function returnedCollectionVariables(
  sourceCode: unknown,
  expression: unknown
): readonly unknown[] {
  if (!isSyntaxNode(expression)) {
    return [];
  }
  if (expression.type === "Identifier") {
    const binding = findVariable(sourceCode, expression);
    return binding ? [binding] : [];
  }
  return returnTransparentOperands(expression).flatMap((operand) =>
    returnedCollectionVariables(sourceCode, operand)
  );
}

export function markReturnedPendingMaps(
  sourceCode: unknown,
  node: unknown,
  pendingAsyncMaps: PendingAsyncMap[]
): void {
  const expression = isSyntaxType(node, "ReturnStatement")
    ? syntaxField(node, "argument")
    : node;
  for (const binding of returnedCollectionVariables(sourceCode, expression)) {
    for (const pending of pendingAsyncMaps) {
      if (pending.variable === binding) {
        pending.returned = true;
      }
    }
  }
}

export function queuePendingAsyncMap(
  sourceCode: unknown,
  node: unknown,
  callback: unknown,
  method: string,
  pendingAsyncMaps: PendingAsyncMap[]
): boolean {
  const parent = syntaxField(node, "parent");
  if (!isSyntaxType(parent, "VariableDeclarator")) {
    return false;
  }
  const binding = getDeclaredVariable(sourceCode, parent);
  if (!binding) {
    return false;
  }
  pendingAsyncMaps.push({
    variable: binding,
    node: callback,
    method,
    awaited: false,
    returned: false,
  });
  return true;
}
