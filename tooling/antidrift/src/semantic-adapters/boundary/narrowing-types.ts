import ts from "typescript";

import { isAppeasementCastSourceType } from "./broad-input-type.ts";
import {
  memberKeyText,
  skipTransparentExpressions,
} from "./narrowing-syntax.ts";
import {
  sameType,
  TypeDifference,
  unionConstituents,
} from "./type-difference.ts";

const NON_PRIMITIVE_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive;

function isAutoTypedVariable(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    !declaration.type &&
    !declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent)
  );
}

function indexedMemberType(
  checker: ts.TypeChecker,
  objectType: ts.Type,
  keyNode: ts.Node
): ts.Type | null {
  const keyFlags = ts.isNumericLiteral(keyNode)
    ? ts.TypeFlags.NumberLike
    : ts.TypeFlags.StringLike;
  const indexSignatures = checker.getIndexInfosOfType(objectType);
  const keyedSignature =
    indexSignatures.find(
      (signature) => (signature.keyType.flags & keyFlags) !== 0
    ) ?? indexSignatures[0];
  return keyedSignature?.type ?? null;
}

function declaredMemberType(
  checker: ts.TypeChecker,
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression
): ts.Type | null {
  const objectType = checker.getTypeAtLocation(member.expression);
  if ((objectType.flags & ts.TypeFlags.Any) !== 0) {
    return objectType;
  }
  const keyNode = ts.isPropertyAccessExpression(member)
    ? member.name
    : member.argumentExpression;
  const memberSymbol =
    memberKeyText(member) === null
      ? undefined
      : checker.getSymbolAtLocation(keyNode);
  if (memberSymbol && (memberSymbol.flags & ts.SymbolFlags.Signature) === 0) {
    return checker.getTypeOfSymbol(memberSymbol);
  }
  return indexedMemberType(checker, objectType, keyNode);
}

export function isBroadSourceType(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return !constraint || isBroadSourceType(checker, constraint);
  }
  return isAppeasementCastSourceType(type);
}

export function declaredOperandType(
  checker: ts.TypeChecker,
  operand: ts.Expression,
  flowType: ts.Type
): ts.Type {
  const reference = skipTransparentExpressions(operand);
  if (ts.isIdentifier(reference)) {
    const symbol = checker.getSymbolAtLocation(reference);
    return symbol && !isAutoTypedVariable(symbol)
      ? checker.getTypeOfSymbol(symbol)
      : flowType;
  }
  if (
    ts.isPropertyAccessExpression(reference) ||
    ts.isElementAccessExpression(reference)
  ) {
    return declaredMemberType(checker, reference) ?? flowType;
  }
  return flowType;
}

function isNonPrimitiveType(type: ts.Type): boolean {
  return unionConstituents(type).every((constituent) =>
    constituent.isIntersection()
      ? constituent.types.some(
          (member) => (member.flags & NON_PRIMITIVE_FLAGS) !== 0
        )
      : (constituent.flags & NON_PRIMITIVE_FLAGS) !== 0
  );
}

export function claimsOnlyUnknownValuedKeys(
  checker: ts.TypeChecker,
  targetType: ts.Type
): boolean {
  const indexTypes = checker
    .getIndexInfosOfType(targetType)
    .map((signature) => signature.type);
  return (
    (targetType.flags & ts.TypeFlags.Object) !== 0 &&
    checker.getPropertiesOfType(targetType).length === 0 &&
    targetType.getCallSignatures().length === 0 &&
    targetType.getConstructSignatures().length === 0 &&
    indexTypes.length > 0 &&
    indexTypes.every(
      (indexType) => (indexType.flags & ts.TypeFlags.Unknown) !== 0
    )
  );
}

export function narrowingProvesTarget(
  checker: ts.TypeChecker,
  flowType: ts.Type,
  targetType: ts.Type,
  onPairCap?: () => void
): boolean {
  if (isBroadSourceType(checker, flowType)) {
    return false;
  }
  if (sameType(checker, flowType, targetType)) {
    return true;
  }
  if (checker.isTypeAssignableTo(flowType, targetType)) {
    const difference = new TypeDifference(checker);
    const different = difference.differs(flowType, targetType);
    if (difference.capped && onPairCap) {
      onPairCap();
    }
    return !different;
  }
  return (
    isNonPrimitiveType(flowType) &&
    !checker.isArrayLikeType(targetType) &&
    claimsOnlyUnknownValuedKeys(checker, targetType)
  );
}
