import ts from "typescript";

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

export type GoverningConstruct =
  | ts.IfStatement
  | ts.WhileStatement
  | ts.DoStatement
  | ts.ForStatement
  | ts.ConditionalExpression
  | ts.SwitchStatement;

type GoverningAncestor = GoverningConstruct | ts.ExpressionStatement;

const GOVERNING_GUARDS = [
  ts.isIfStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isForStatement,
  ts.isConditionalExpression,
  ts.isSwitchStatement,
] as const;

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

function isThisExpression(node: ts.Node): node is ts.ThisExpression {
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

function isReferenceRoot(
  node: ts.Node
): node is ts.Identifier | ts.ThisExpression {
  return ts.isIdentifier(node) || isThisExpression(node);
}

export function referenceChain(expression: ts.Expression) {
  const memberNames: string[] = [];
  let current = skipTransparentExpressions(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const keyText = memberKeyText(current);
    if (keyText === null) {
      return null;
    }
    memberNames.unshift(keyText);
    current = skipTransparentExpressions(current.expression);
  }
  return isReferenceRoot(current) ? { root: current, memberNames } : null;
}

export type ReferenceChain = NonNullable<ReturnType<typeof referenceChain>>;

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

export function enclosingContainer(node: ts.Node): ts.Node {
  return (
    ts.findAncestor(
      node.parent,
      (ancestor) => ts.isFunctionLike(ancestor) || ts.isSourceFile(ancestor)
    ) ?? node.getSourceFile()
  );
}

export function thisContainer(node: ts.Node): ts.Node {
  return (
    ts.findAncestor(
      node.parent,
      (ancestor) =>
        (ts.isFunctionLike(ancestor) && !ts.isArrowFunction(ancestor)) ||
        ts.isClassLike(ancestor) ||
        ts.isSourceFile(ancestor)
    ) ?? node.getSourceFile()
  );
}

export function collectThisOccurrences(
  container: ts.Node
): ts.ThisExpression[] {
  const occurrences: ts.ThisExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isThisExpression(node)) {
      occurrences.push(node);
      return;
    }
    if (
      node !== container &&
      ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
        ts.isClassLike(node))
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(container);
  return occurrences;
}

export function chainOccurrence(
  rootOccurrence: ts.Expression,
  memberNames: readonly string[]
) {
  let occurrence: ts.Expression = rootOccurrence;
  const occurrences = [{ node: rootOccurrence, remainder: memberNames }];
  for (const [index, memberName] of memberNames.entries()) {
    const parent = occurrence.parent;
    const chainParent =
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)
        ? parent
        : undefined;
    if (
      !chainParent ||
      chainParent.expression !== occurrence ||
      memberKeyText(chainParent) !== memberName
    ) {
      break;
    }
    occurrence = chainParent;
    occurrences.push({
      node: chainParent,
      remainder: memberNames.slice(index + 1),
    });
  }
  return occurrences;
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

export function enclosingIterationStatement(
  node: ts.Node,
  boundary: ts.Node
): ts.Node | undefined {
  return ts.findAncestor(node.parent, (ancestor) => {
    if (ancestor === boundary) {
      return "quit";
    }
    return ts.isIterationStatement(ancestor, false);
  });
}

export function executesBeforeCast(
  node: ts.Node,
  castNode: ts.Node,
  loop: ts.Node | undefined
): boolean {
  if (node.end <= castNode.getStart()) {
    return true;
  }
  return Boolean(
    loop &&
    node.pos >= loop.pos &&
    node.end <= loop.end &&
    !(node.pos <= castNode.pos && node.end >= castNode.end)
  );
}

export function callOperands(
  call: ts.CallExpression
): readonly ts.Expression[] {
  return ts.isPropertyAccessExpression(call.expression)
    ? [...call.arguments, call.expression.expression]
    : call.arguments;
}

export function isGoverningConstruct(
  node: ts.Node
): node is GoverningConstruct {
  return GOVERNING_GUARDS.some((guard) => guard(node));
}

function isGoverningAncestor(node: ts.Node): node is GoverningAncestor {
  return isGoverningConstruct(node) || ts.isExpressionStatement(node);
}

export function governingConstruct(
  testNode: ts.Node
): GoverningConstruct | ts.ExpressionStatement | undefined {
  const ancestor = ts.findAncestor(
    testNode,
    (node) =>
      ts.isFunctionLike(node) ||
      ts.isSourceFile(node) ||
      isGoverningAncestor(node)
  );
  return ancestor === undefined || !isGoverningAncestor(ancestor)
    ? undefined
    : ancestor;
}

export function governingCondition(
  construct: GoverningAncestor
): ts.Expression | undefined {
  return ts.isForStatement(construct) || ts.isConditionalExpression(construct)
    ? construct.condition
    : construct.expression;
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

export function isWithin(
  node: ts.Node,
  container: ts.Node | undefined
): boolean {
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

export function testConsumers(occurrence: ts.Expression): ts.Node[] {
  const reference = skipOuterParents(occurrence);
  const parent = reference.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === reference)
  ) {
    return [parent.expression, ...(parent.typeArguments ?? [])];
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return [parent];
  }
  if (ts.isBinaryExpression(parent)) {
    const operatorKind = parent.operatorToken.kind;
    if (
      operatorKind === ts.SyntaxKind.InstanceOfKeyword &&
      parent.left === reference
    ) {
      return [parent.right];
    }
    if (EQUALITY_OPERATOR_KINDS.has(operatorKind)) {
      return [parent.left === reference ? parent.right : parent.left];
    }
  }
  if (ts.isSwitchStatement(parent) && parent.expression === reference) {
    return parent.caseBlock.clauses.flatMap((clause) =>
      ts.isCaseClause(clause) ? [clause.expression] : []
    );
  }
  return [];
}
