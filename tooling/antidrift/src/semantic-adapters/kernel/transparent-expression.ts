import ts from "typescript";

function isTransparentWrapper(node: ts.Node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

export function unwrapTransparent<Wrapped extends ts.Node>(
  node: Wrapped
): Wrapped | ts.Expression {
  let current: Wrapped | ts.Expression = node;
  while (isTransparentWrapper(current)) {
    current = current.expression;
  }
  return current;
}
