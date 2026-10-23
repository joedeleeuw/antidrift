import ts from "typescript";

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

export const EQUALITY_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

export function skipTransparentExpressions(
  expression: ts.Expression
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function memberKeyText(expression: MemberAccess): string | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  const key = expression.argumentExpression;
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
    ? key.text
    : null;
}

export function skipOuterParents(expression: ts.Expression): ts.Expression;
export function skipOuterParents(node: ts.Node): ts.Node;
export function skipOuterParents(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

export function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  return (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function alwaysExits(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && alwaysExits(last);
  }
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

function isWithin(node: ts.Node, container: ts.Node | undefined): boolean {
  return (
    Boolean(container) &&
    ts.findAncestor(node, (ancestor) => ancestor === container) !== undefined
  );
}

export function isEarlyExitGuard(
  statement: ts.Node,
  castNode: ts.Node
): statement is ts.IfStatement {
  return (
    ts.isIfStatement(statement) &&
    !statement.elseStatement &&
    alwaysExits(statement.thenStatement) &&
    statement.end <= castNode.getStart() &&
    isWithin(castNode, statement.parent)
  );
}

export function isNullishLiteral(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}
