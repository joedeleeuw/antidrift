import ts from "typescript";

export function locationOf(node: ts.Node) {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${line + 1}`;
}
function isTransparentWrapper(
  node: ts.Node
): node is
  | ts.ParenthesizedExpression
  | ts.AssertionExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}
export function unwrapped(node: ts.Node) {
  let current: ts.Node = node;
  while (isTransparentWrapper(current)) {
    current = current.expression;
  }
  return current;
}
export function outermostWrapper(node: ts.Node) {
  let current: ts.Node = node;
  while (
    !ts.isSourceFile(current) &&
    isTransparentWrapper(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}
export const LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);
