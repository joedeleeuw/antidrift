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

export const safeExpressionKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.OmittedExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.TypeOfExpression,
  ts.SyntaxKind.VoidExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.ImportKeyword,
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxSelfClosingElement,
  ts.SyntaxKind.JsxFragment,
]);

function contains(ancestor, node) {
  return ancestor.pos <= node.pos && ancestor.end >= node.end;
}

export function unconditionalBefore(write, use) {
  if (write.end >= use.pos) {
    return false;
  }
  let ancestor = write.parent;
  while (ancestor && !ts.isFunctionLike(ancestor)) {
    if (
      (ts.isBlock(ancestor) ||
        ts.isIfStatement(ancestor) ||
        ts.isConditionalExpression(ancestor) ||
        ts.isIterationStatement(ancestor, false)) &&
      !contains(ancestor, use)
    ) {
      return false;
    }
    ancestor = ancestor.parent;
  }
  return ancestor === enclosingFunction(use);
}
