import ts from "typescript";

import { dataProperty, objectType } from "../shape/contract-types.ts";
import type { OwnerProjection } from "./owner-projection.ts";

export type ValuePath = {
  readonly symbol: ts.Symbol;
  readonly path: readonly string[];
};

export type DiscriminantBridge = ValuePath & {
  readonly field: string;
  readonly owner: OwnerProjection;
};

type EqualityGuard = ValuePath & {
  readonly field: string;
  readonly value: string;
};

type RootReference = {
  readonly checker: ts.TypeChecker;
  readonly bridge: DiscriminantBridge;
  readonly declarationName: ts.BindingName;
};

function valueSymbol(checker: ts.TypeChecker, node: ts.Identifier) {
  return ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
}

export function valuePath(
  checker: ts.TypeChecker,
  expression: ts.Expression
): ValuePath | null {
  if (ts.isParenthesizedExpression(expression)) {
    return valuePath(checker, expression.expression);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = valueSymbol(checker, expression);
    return symbol ? { symbol, path: [] } : null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    !expression.questionDotToken
  ) {
    const root = valuePath(checker, expression.expression);
    return (
      root && {
        symbol: root.symbol,
        path: [...root.path, expression.name.text],
      }
    );
  }
  return null;
}

export function samePath(left: ValuePath, right: ValuePath): boolean {
  return (
    left.symbol === right.symbol && left.path.join(".") === right.path.join(".")
  );
}

function propertyType(checker: ts.TypeChecker, type: ts.Type, name: string) {
  const property = checker.getPropertyOfType(type, name);
  return property && checker.getTypeOfSymbol(property);
}

function finiteStrings(type: ts.Type | undefined) {
  if (!type) {
    return null;
  }
  const parts = type.isUnion() ? type.types : [type];
  const literals = parts.filter((part) => part.isStringLiteral());
  return literals.length === parts.length
    ? new Set(literals.map((literal) => literal.value))
    : null;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return (
    left.size === right.size && [...left].every((entry) => right.has(entry))
  );
}

function declaredPathType(checker: ts.TypeChecker, path: ValuePath) {
  let type = checker.getTypeOfSymbol(path.symbol);
  for (const field of path.path) {
    if (!objectType(type)) {
      return null;
    }
    const property = checker.getPropertyOfType(type, field);
    if (!property || !dataProperty(property)) {
      return null;
    }
    type = checker.getTypeOfSymbol(property);
  }
  return objectType(type) ? type : null;
}

function hasMatchingChild(
  node: ts.Node,
  predicate: (child: ts.Node) => boolean
) {
  return (
    ts.forEachChild(node, (child) => (predicate(child) ? true : undefined)) ===
    true
  );
}

function containsRoot(reference: RootReference, node: ts.Node): boolean {
  if (
    ts.isIdentifier(node) &&
    valueSymbol(reference.checker, node) === reference.bridge.symbol
  ) {
    return true;
  }
  return hasMatchingChild(node, (child) => containsRoot(reference, child));
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function writesRoot(reference: RootReference, node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    return (
      isAssignmentOperator(node.operatorToken.kind) &&
      containsRoot(reference, node.left)
    );
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return (
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      containsRoot(reference, node.operand)
    );
  }
  if (
    ts.isDeleteExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node)
  ) {
    return containsRoot(reference, node.expression);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    containsRoot(reference, node.expression) &&
    !dataProperty(
      reference.checker.getPropertyOfType(
        reference.checker.getTypeAtLocation(node.expression),
        node.name.text
      )
    )
  );
}

function escapesRoot(reference: RootReference, node: ts.Node): boolean {
  if (
    !ts.isIdentifier(node) ||
    node === reference.declarationName ||
    valueSymbol(reference.checker, node) !== reference.bridge.symbol
  ) {
    return false;
  }
  let use: ts.Expression = node;
  while (
    ts.isPropertyAccessExpression(use.parent) &&
    use.parent.expression === use
  ) {
    use = use.parent;
  }
  const path = valuePath(reference.checker, use);
  return (
    path !== null &&
    path.path.length <= reference.bridge.path.length &&
    !(ts.isJsxExpression(use.parent) && ts.isJsxAttribute(use.parent.parent))
  );
}

function unstableAt(reference: RootReference, node: ts.Node): boolean {
  if (writesRoot(reference, node)) {
    return true;
  }
  return (
    escapesRoot(reference, node) ||
    hasMatchingChild(node, (child) => unstableAt(reference, child))
  );
}

export function stableBridge(
  checker: ts.TypeChecker,
  bridge: DiscriminantBridge
): boolean {
  const declaration = bridge.symbol.valueDeclaration;
  if (
    !declaration ||
    (!ts.isParameter(declaration) &&
      !ts.isVariableDeclaration(declaration) &&
      !ts.isBindingElement(declaration))
  ) {
    return false;
  }
  return !unstableAt(
    { checker, bridge, declarationName: declaration.name },
    declaration.getSourceFile()
  );
}

function guardSide(
  checker: ts.TypeChecker,
  member: ts.Expression,
  literal: ts.Expression
): EqualityGuard | null {
  if (
    !ts.isPropertyAccessExpression(member) ||
    member.questionDotToken ||
    !ts.isStringLiteral(literal)
  ) {
    return null;
  }
  const root = valuePath(checker, member.expression);
  return root && { ...root, field: member.name.text, value: literal.text };
}

function equalityGuard(checker: ts.TypeChecker, expression: ts.Expression) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  return (
    guardSide(checker, expression.left, expression.right) ??
    guardSide(checker, expression.right, expression.left)
  );
}

function outputTag(expression: ts.Expression, field: string): string | null {
  if (ts.isParenthesizedExpression(expression)) {
    return outputTag(expression.expression, field);
  }
  if (
    !ts.isObjectLiteralExpression(expression) ||
    expression.properties.some(
      (member) =>
        ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)
    )
  ) {
    return null;
  }
  const properties = expression.properties.filter((member) => {
    const { name } = member;
    return (
      name !== undefined &&
      (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
      name.text === field
    );
  });
  const [property] = properties;
  return properties.length === 1 &&
    property &&
    ts.isPropertyAssignment(property) &&
    ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : null;
}

export function trustedSource(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen: ReadonlySet<ts.Symbol> = new Set()
): boolean {
  const path = valuePath(checker, expression);
  if (!path || seen.has(path.symbol) || !path.symbol.valueDeclaration) {
    return false;
  }
  let declaration: ts.Declaration = path.symbol.valueDeclaration;
  while (ts.isBindingElement(declaration)) {
    declaration = declaration.parent.parent;
  }
  if (ts.isParameter(declaration)) {
    return !declaration.initializer;
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return false;
  }
  const { initializer } = declaration;
  if (
    ts.isAsExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer) ||
    (checker.getTypeAtLocation(initializer).flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
      0
  ) {
    return false;
  }
  if (ts.isCallExpression(initializer)) {
    return true;
  }
  return trustedSource(checker, initializer, new Set([...seen, path.symbol]));
}

function bridgeCases(
  checker: ts.TypeChecker,
  guard: EqualityGuard,
  owner: OwnerProjection
) {
  const source = declaredPathType(checker, guard);
  const sourceField = source && checker.getPropertyOfType(source, guard.field);
  if (!source || !sourceField || !dataProperty(sourceField)) {
    return null;
  }
  const sourceCases = finiteStrings(propertyType(checker, source, guard.field));
  const ownerCases = finiteStrings(
    propertyType(checker, owner.type, guard.field)
  );
  return sourceCases &&
    ownerCases &&
    sameSet(sourceCases, ownerCases) &&
    sourceCases.size >= 2
    ? sourceCases
    : null;
}

function coversCases(
  checker: ts.TypeChecker,
  expression: ts.ConditionalExpression,
  guard: EqualityGuard,
  cases: ReadonlySet<string>
): boolean {
  const remaining = new Set(cases);
  let branch: ts.Expression = expression;
  while (ts.isConditionalExpression(branch)) {
    const current = equalityGuard(checker, branch.condition);
    if (
      !current ||
      !samePath(guard, current) ||
      current.field !== guard.field ||
      !remaining.has(current.value) ||
      outputTag(branch.whenTrue, guard.field) !== current.value
    ) {
      return false;
    }
    remaining.delete(current.value);
    branch = branch.whenFalse;
  }
  const tail = outputTag(branch, guard.field);
  return remaining.size === 1 && tail !== null && remaining.has(tail);
}

export function discriminantBridge(
  checker: ts.TypeChecker,
  expression: ts.ConditionalExpression,
  owner: OwnerProjection
): DiscriminantBridge | null {
  const guard = equalityGuard(checker, expression.condition);
  const declaration = guard?.symbol.valueDeclaration;
  const binding = declaration && ts.getNameOfDeclaration(declaration);
  if (
    !guard ||
    !binding ||
    !ts.isIdentifier(binding) ||
    !trustedSource(checker, binding)
  ) {
    return null;
  }
  const cases = bridgeCases(checker, guard, owner);
  if (!cases || !coversCases(checker, expression, guard, cases)) {
    return null;
  }
  return { symbol: guard.symbol, path: guard.path, field: guard.field, owner };
}
