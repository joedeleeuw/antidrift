import ts from "typescript";
import { typed } from "./boundary-declarations.mjs";

export const ELEMENT = "[]";

export const logicalOperators = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

export const assertionKinds = new Set([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

export function unresolvedType(type) {
  return Boolean(type) && type.intrinsicName === "error";
}

export function contractProjection(checker) {
  function literalText(expression) {
    if (!expression) return null;
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
    const keyType = checker.getTypeAtLocation(expression);
    return keyType.isStringLiteral() || keyType.isNumberLiteral()
      ? String(keyType.value)
      : null;
  }

  function propertyKey(property) {
    const { name } = property;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return name.text;
    }
    return literalText(
      ts.isComputedPropertyName(name) ? name.expression : name
    );
  }

  function accessKey(expression) {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return literalText(expression.argumentExpression);
  }

  function memberContract(contract, memberName) {
    if (!contract) return null;
    if (
      contract.flags & ts.TypeFlags.TypeParameter ||
      unresolvedType(contract)
    ) {
      return contract;
    }
    const owner = contract.getNonNullableType();
    const property =
      memberName !== null && checker.getPropertyOfType(owner, memberName);
    if (property) return checker.getTypeOfSymbol(property);
    return (
      checker.getIndexTypeOfType(owner, ts.IndexKind.String) ??
      checker.getIndexTypeOfType(owner, ts.IndexKind.Number) ??
      null
    );
  }

  function elementContract(contract) {
    if (!contract) return null;
    if (
      contract.flags & ts.TypeFlags.TypeParameter ||
      unresolvedType(contract)
    ) {
      return contract;
    }
    return (
      checker.getIndexTypeOfType(
        contract.getNonNullableType(),
        ts.IndexKind.Number
      ) ?? null
    );
  }

  function projectContract(contract, path = []) {
    return path.reduce(
      (current, step) =>
        step === ELEMENT
          ? elementContract(current)
          : memberContract(current, step),
      contract
    );
  }

  function claimContract(contract) {
    if (!contract) return null;
    if (contract.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(contract);
      return constraint && constraint !== contract
        ? claimContract(constraint)
        : null;
    }
    return typed(contract) || unresolvedType(contract) ? contract : null;
  }

  return {
    accessKey,
    claimContract,
    elementContract,
    memberContract,
    projectContract,
    propertyKey,
  };
}
