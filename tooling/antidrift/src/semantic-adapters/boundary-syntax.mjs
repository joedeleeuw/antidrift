import ts from "typescript";

export const wrapperKinds = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.SatisfiesExpression,
]);

export function unwrapExpression(expression) {
  let current = expression;
  while (current && wrapperKinds.has(current.kind) && current.expression) {
    current = current.expression;
  }
  return current;
}

export function enclosingFunction(node) {
  let ancestor = node.parent;
  while (ancestor && !ts.isFunctionLike(ancestor)) ancestor = ancestor.parent;
  return ancestor;
}

export function callbackReturns(callback) {
  if (!callback.body) return [];
  if (!ts.isBlock(callback.body)) return [callback.body];
  const expressions = [];
  function visit(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) expressions.push(node.expression ?? node);
    ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return expressions;
}

export function isAssertionChain(expression) {
  let current = expression;
  let assertions = 0;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      assertions += 1;
      current = current.expression;
      continue;
    }
    break;
  }
  return assertions >= 2;
}
