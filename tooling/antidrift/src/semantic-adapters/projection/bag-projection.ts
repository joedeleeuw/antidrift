import ts from "typescript";

import { unwrapTransparent } from "../kernel/transparent-expression.ts";
import { isPlainBagParameterType } from "./bag-type.ts";
import {
  resolveAliasedSymbol,
  symbolAtNode,
} from "../provenance/symbol-provenance.ts";

export type BagScope = {
  readonly checker: ts.TypeChecker;
  readonly rootSymbols: Set<ts.Symbol>;
  readonly fieldSymbols: Set<ts.Symbol>;
};

type BagRead = { readonly valid: boolean; readonly readsBagField: boolean };

const PRIMITIVE_COERCION_CALLEES = new Set(["Boolean", "Number", "String"]);

const SCALAR_KEYWORD_KINDS = new Set([
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const SIGNED_NUMBER_OPERATORS = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PlusToken,
]);

const SIZE_MEMBERS = new Set(["length", "size"]);

const EMPTY_FALLBACK_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);

const VALUE_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

const CONDITION_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const INVALID_READ: BagRead = { valid: false, readsBagField: false };

const STATIC_READ: BagRead = { valid: true, readsBagField: false };

const FIELD_READ: BagRead = { valid: true, readsBagField: true };

function isUndefinedIdentifier(expression: ts.Node): boolean {
  return ts.isIdentifier(expression) && expression.text === "undefined";
}

function isNullishExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapTransparent(expression);
  return (
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    isUndefinedIdentifier(unwrapped) ||
    (ts.isVoidExpression(unwrapped) &&
      ts.isNumericLiteral(unwrapped.expression) &&
      unwrapped.expression.text === "0")
  );
}

function isStaticScalarLiteral(expression: ts.Expression): boolean {
  const unwrapped = unwrapTransparent(expression);
  if (
    ts.isStringLiteralLike(unwrapped) ||
    ts.isNumericLiteral(unwrapped) ||
    ts.isBigIntLiteral(unwrapped) ||
    SCALAR_KEYWORD_KINDS.has(unwrapped.kind) ||
    isUndefinedIdentifier(unwrapped)
  ) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(unwrapped) &&
    SIGNED_NUMBER_OPERATORS.has(unwrapped.operator) &&
    ts.isNumericLiteral(unwrapped.operand)
  );
}

function isEmptyObjectFallback(expression: ts.Expression): boolean {
  const unwrapped = unwrapTransparent(expression);
  return (
    ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length === 0
  );
}

export function isStaticMemberAccess(
  node: ts.Node
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) ||
    (ts.isElementAccessExpression(node) &&
      isStaticScalarLiteral(node.argumentExpression))
  );
}

function bindFieldElement(scope: BagScope, element: ts.BindingElement) {
  if (
    element.dotDotDotToken ||
    (element.initializer &&
      !isStaticScalarLiteral(element.initializer) &&
      !isEmptyObjectFallback(element.initializer))
  ) {
    return false;
  }
  if (ts.isIdentifier(element.name)) {
    const boundSymbol = resolveAliasedSymbol(
      scope.checker,
      scope.checker.getSymbolAtLocation(element.name)
    );
    if (!boundSymbol) {
      return false;
    }
    scope.fieldSymbols.add(boundSymbol);
    return true;
  }
  return (
    ts.isObjectBindingPattern(element.name) &&
    bindFieldPattern(scope, element.name)
  );
}

function bindFieldPattern(
  scope: BagScope,
  bindingPattern: ts.ObjectBindingPattern
): boolean {
  for (const element of bindingPattern.elements) {
    if (!bindFieldElement(scope, element)) {
      return false;
    }
  }
  return true;
}

function isBagParameterShape(parameter: ts.ParameterDeclaration): boolean {
  const { initializer } = parameter;
  return (
    !parameter.dotDotDotToken &&
    !ts.isArrayBindingPattern(parameter.name) &&
    (!initializer ||
      isEmptyObjectFallback(initializer) ||
      isNullishExpression(initializer))
  );
}

export function resolveBagParameter(
  functionNode: ts.SignatureDeclarationBase,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
) {
  const valueParameters = functionNode.parameters.filter(
    (parameter) =>
      !(ts.isIdentifier(parameter.name) && parameter.name.text === "this")
  );
  const [parameter] = valueParameters;
  if (
    valueParameters.length !== 1 ||
    !parameter ||
    !isBagParameterShape(parameter) ||
    !isPlainBagParameterType(checker, parameter)
  ) {
    return null;
  }
  const scope: BagScope = {
    checker,
    rootSymbols: new Set(),
    fieldSymbols: new Set(),
  };
  if (ts.isIdentifier(parameter.name)) {
    const rootSymbol = resolveAliasedSymbol(
      checker,
      checker.getSymbolAtLocation(parameter.name)
    );
    if (!rootSymbol) {
      return null;
    }
    scope.rootSymbols.add(rootSymbol);
    return { parameterName: parameter.name.text, scope };
  }
  if (
    ts.isObjectBindingPattern(parameter.name) &&
    bindFieldPattern(scope, parameter.name) &&
    scope.fieldSymbols.size > 0
  ) {
    return {
      parameterName: parameter.name.getText(sourceFile).replace(/\s+/gu, " "),
      scope,
    };
  }
  return null;
}

function isBagSymbol(scope: BagScope, symbol: ts.Symbol | null): boolean {
  return (
    symbol !== null &&
    (scope.rootSymbols.has(symbol) || scope.fieldSymbols.has(symbol))
  );
}

function isBagMemberChain(scope: BagScope, expression: ts.Expression): boolean {
  const unwrapped = unwrapTransparent(expression);
  if (
    !isStaticMemberAccess(unwrapped) ||
    (ts.isPropertyAccessExpression(unwrapped) &&
      SIZE_MEMBERS.has(unwrapped.name.text))
  ) {
    return false;
  }
  const receiver = unwrapTransparent(unwrapped.expression);
  if (ts.isIdentifier(receiver)) {
    return isBagSymbol(scope, symbolAtNode(scope.checker, receiver));
  }
  return isBagMemberChain(scope, receiver);
}

export function isBagObjectReference(
  scope: BagScope,
  expression: ts.Expression
): boolean {
  const unwrapped = unwrapTransparent(expression);
  if (ts.isIdentifier(unwrapped)) {
    return isBagSymbol(scope, symbolAtNode(scope.checker, unwrapped));
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    EMPTY_FALLBACK_OPERATORS.has(unwrapped.operatorToken.kind) &&
    isEmptyObjectFallback(unwrapped.right)
  ) {
    return isBagObjectReference(scope, unwrapped.left);
  }
  return isBagMemberChain(scope, unwrapped);
}

function isBagOperand(scope: BagScope, operand: ts.Expression): boolean {
  return (
    isPureBagCondition(scope, operand) || isBagObjectReference(scope, operand)
  );
}

export function isPureBagCondition(
  scope: BagScope,
  expression: ts.Expression
): boolean {
  const unwrapped = unwrapTransparent(expression);
  if (inspectBagValueExpression(scope, unwrapped).valid) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return isPureBagCondition(scope, unwrapped.operand);
  }
  if (ts.isTypeOfExpression(unwrapped)) {
    return (
      isBagObjectReference(scope, unwrapped.expression) ||
      inspectBagValueExpression(scope, unwrapped.expression).valid
    );
  }
  return (
    ts.isBinaryExpression(unwrapped) &&
    CONDITION_OPERATORS.has(unwrapped.operatorToken.kind) &&
    isBagOperand(scope, unwrapped.left) &&
    isBagOperand(scope, unwrapped.right)
  );
}

function combinedBagRead(left: BagRead, right: BagRead): BagRead {
  return {
    valid: left.valid && right.valid,
    readsBagField: left.readsBagField || right.readsBagField,
  };
}

function inspectCoercion(scope: BagScope, call: ts.CallExpression): BagRead {
  const [argument] = call.arguments;
  if (
    !ts.isIdentifier(call.expression) ||
    !PRIMITIVE_COERCION_CALLEES.has(call.expression.text) ||
    call.arguments.length !== 1 ||
    !argument
  ) {
    return INVALID_READ;
  }
  const argumentCheck = inspectBagValueExpression(scope, argument);
  return {
    valid: argumentCheck.valid && argumentCheck.readsBagField,
    readsBagField: argumentCheck.readsBagField,
  };
}

function inspectBranchingRead(
  scope: BagScope,
  expression: ts.BinaryExpression | ts.ConditionalExpression
): BagRead {
  if (ts.isBinaryExpression(expression)) {
    return VALUE_OPERATORS.has(expression.operatorToken.kind)
      ? combinedBagRead(
          inspectBagValueExpression(scope, expression.left),
          inspectBagValueExpression(scope, expression.right)
        )
      : INVALID_READ;
  }
  if (!isPureBagCondition(scope, expression.condition)) {
    return INVALID_READ;
  }
  return combinedBagRead(
    inspectBagValueExpression(scope, expression.whenTrue),
    inspectBagValueExpression(scope, expression.whenFalse)
  );
}

export function inspectBagValueExpression(
  scope: BagScope,
  expression: ts.Expression
): BagRead {
  const unwrapped = unwrapTransparent(expression);
  if (isStaticScalarLiteral(unwrapped)) {
    return STATIC_READ;
  }
  if (ts.isIdentifier(unwrapped)) {
    const symbol = symbolAtNode(scope.checker, unwrapped);
    return symbol && scope.fieldSymbols.has(symbol) ? FIELD_READ : INVALID_READ;
  }
  if (isBagMemberChain(scope, unwrapped)) {
    return FIELD_READ;
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return inspectBagValueExpression(scope, unwrapped.operand);
  }
  if (
    ts.isBinaryExpression(unwrapped) ||
    ts.isConditionalExpression(unwrapped)
  ) {
    return inspectBranchingRead(scope, unwrapped);
  }
  if (ts.isCallExpression(unwrapped)) {
    return inspectCoercion(scope, unwrapped);
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return inspectObjectLiteralBagProjection(scope, unwrapped)
      ? FIELD_READ
      : INVALID_READ;
  }
  return INVALID_READ;
}

function inspectBagProperty(
  scope: BagScope,
  property: ts.ObjectLiteralElementLike
): BagRead {
  if (ts.isSpreadAssignment(property)) {
    return isBagObjectReference(scope, property.expression)
      ? FIELD_READ
      : INVALID_READ;
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    const fallback = property.objectAssignmentInitializer;
    const symbol =
      !fallback || isStaticScalarLiteral(fallback)
        ? symbolAtNode(scope.checker, property.name)
        : null;
    return symbol && scope.fieldSymbols.has(symbol) ? FIELD_READ : INVALID_READ;
  }
  if (
    !ts.isPropertyAssignment(property) ||
    (ts.isComputedPropertyName(property.name) &&
      !isStaticScalarLiteral(property.name.expression))
  ) {
    return INVALID_READ;
  }
  return inspectBagValueExpression(scope, property.initializer);
}

export function inspectObjectLiteralBagProjection(
  scope: BagScope,
  objectLiteral: ts.ObjectLiteralExpression
): boolean {
  let readsBagField = false;
  for (const property of objectLiteral.properties) {
    const propertyRead = inspectBagProperty(scope, property);
    if (!propertyRead.valid) {
      return false;
    }
    readsBagField ||= propertyRead.readsBagField;
  }
  return readsBagField;
}

export function collectReturnExpressionsFromExpression(
  expression: ts.Expression | undefined,
  returnBucket: ts.Expression[]
): boolean {
  if (!expression || isNullishExpression(expression)) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return collectReturnExpressionsFromExpression(
      expression.expression,
      returnBucket
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      collectReturnExpressionsFromExpression(
        expression.whenTrue,
        returnBucket
      ) &&
      collectReturnExpressionsFromExpression(expression.whenFalse, returnBucket)
    );
  }
  returnBucket.push(expression);
  return true;
}

function bindBagDeclaration(
  scope: BagScope,
  declaration: ts.VariableDeclaration
): boolean {
  const { initializer, name } = declaration;
  if (!initializer) {
    return false;
  }
  if (ts.isObjectBindingPattern(name)) {
    return (
      isBagObjectReference(scope, initializer) && bindFieldPattern(scope, name)
    );
  }
  if (!ts.isIdentifier(name)) {
    return false;
  }
  const valueCheck = inspectBagValueExpression(scope, initializer);
  const localSymbol =
    valueCheck.valid && valueCheck.readsBagField
      ? resolveAliasedSymbol(
          scope.checker,
          scope.checker.getSymbolAtLocation(name)
        )
      : null;
  if (!localSymbol) {
    return false;
  }
  scope.fieldSymbols.add(localSymbol);
  return true;
}

export function collectStatementReturnExpressions(
  scope: BagScope,
  statement: ts.Statement,
  returnBucket: ts.Expression[]
): boolean {
  if (ts.isBlock(statement)) {
    return statement.statements.every((childStatement) =>
      collectStatementReturnExpressions(scope, childStatement, returnBucket)
    );
  }
  if (ts.isReturnStatement(statement)) {
    return collectReturnExpressionsFromExpression(
      statement.expression,
      returnBucket
    );
  }
  if (ts.isIfStatement(statement)) {
    const { elseStatement } = statement;
    return (
      isPureBagCondition(scope, statement.expression) &&
      collectStatementReturnExpressions(
        scope,
        statement.thenStatement,
        returnBucket
      ) &&
      (!elseStatement ||
        collectStatementReturnExpressions(scope, elseStatement, returnBucket))
    );
  }
  if (!ts.isVariableStatement(statement)) {
    return false;
  }
  const { declarationList } = statement;
  return (
    (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    declarationList.declarations.every((declaration) =>
      bindBagDeclaration(scope, declaration)
    )
  );
}
