import ts from "typescript";

type WrapperExpression =
  | ts.ParenthesizedExpression
  | ts.AwaitExpression
  | ts.YieldExpression
  | ts.NonNullExpression
  | ts.AsExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression;

export const wrapperKinds: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.SatisfiesExpression,
]);

function isWrapperExpression(node: ts.Node): node is WrapperExpression {
  return wrapperKinds.has(node.kind);
}

export function unwrapExpression(expression: ts.Expression): ts.Expression;
export function unwrapExpression(
  expression: ts.Expression | undefined
): ts.Expression | undefined;
export function unwrapExpression(expression: ts.Expression | undefined) {
  let current = expression;
  while (current && isWrapperExpression(current) && current.expression) {
    current = current.expression;
  }
  return current;
}

export function enclosingFunction(node: ts.Node) {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

export function callbackReturns(callback: ts.SignatureDeclaration) {
  const body = "body" in callback ? callback.body : undefined;
  if (!body) {
    return [];
  }
  if (!ts.isBlock(body)) {
    return [body];
  }
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return expressions;
}

export function isAssertionChain(expression: ts.Expression): boolean {
  let current = expression;
  let assertions = 0;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    if (!ts.isParenthesizedExpression(current)) {
      assertions += 1;
    }
    current = current.expression;
  }
  return assertions >= 2;
}

export const safeExpressionKinds: ReadonlySet<ts.SyntaxKind> = new Set([
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

function contains(ancestor: ts.Node, node: ts.Node): boolean {
  return ancestor.pos <= node.pos && ancestor.end >= node.end;
}

function isBranchingAncestor(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isIterationStatement(node, false)
  );
}

export function unconditionalBefore(write: ts.Node, use: ts.Node): boolean {
  if (write.end >= use.pos) {
    return false;
  }
  const stop = ts.findAncestor(
    write.parent,
    (ancestor) =>
      ts.isFunctionLike(ancestor) ||
      (isBranchingAncestor(ancestor) && !contains(ancestor, use))
  );
  if (stop && !ts.isFunctionLike(stop)) {
    return false;
  }
  return stop === enclosingFunction(use);
}
