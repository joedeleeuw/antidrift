import ts from "typescript";
import { shapeless, typed } from "./boundary/boundary-types.ts";

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
  function literalKeys(expression) {
    if (!expression) return null;
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return new Set([expression.text]);
    }
    const keyType = checker.getTypeAtLocation(expression);
    const members = keyType.isUnion() ? keyType.types : [keyType];
    if (
      !members.every(
        (member) => member.isStringLiteral() || member.isNumberLiteral()
      )
    ) {
      return null;
    }
    return new Set(members.map((member) => String(member.value)));
  }

  function literalText(expression) {
    const keys = literalKeys(expression);
    return keys?.size === 1 ? [...keys][0] : null;
  }

  function propertyKeys(property) {
    const { name } = property;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
      return new Set([name.text]);
    }
    return literalKeys(
      ts.isComputedPropertyName(name) ? name.expression : name
    );
  }

  function accessKeys(expression) {
    if (ts.isPropertyAccessExpression(expression)) {
      return new Set([expression.name.text]);
    }
    return literalKeys(expression.argumentExpression);
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

  function passesThrough(contract) {
    return Boolean(
      contract.flags & ts.TypeFlags.TypeParameter || unresolvedType(contract)
    );
  }

  function soleAcrossOwners(contract, projection) {
    const owner = contract.getNonNullableType();
    const whole = projection(owner);
    if (whole || !owner.isUnion()) return whole ?? null;
    const contracts = owner.types.map(projection).filter(Boolean);
    return contracts.length === 1 ? contracts[0] : null;
  }

  function memberContract(contract, memberName) {
    if (!contract) return null;
    if (passesThrough(contract)) return contract;
    return soleAcrossOwners(contract, (owner) => {
      if (owner.flags & ts.TypeFlags.Primitive) return null;
      const property =
        memberName !== null && checker.getPropertyOfType(owner, memberName);
      if (property) return checker.getTypeOfSymbol(property);
      return (
        checker.getIndexTypeOfType(owner, ts.IndexKind.String) ??
        checker.getIndexTypeOfType(owner, ts.IndexKind.Number) ??
        null
      );
    });
  }

  function elementContract(contract) {
    if (!contract) return null;
    if (passesThrough(contract)) return contract;
    return soleAcrossOwners(contract, (owner) =>
      checker.getIndexTypeOfType(owner, ts.IndexKind.Number)
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

  function stripNullish(type) {
    if (
      type.aliasSymbol?.escapedName === "Awaited" &&
      type.aliasTypeArguments?.length === 1
    ) {
      return stripNullish(type.aliasTypeArguments[0]);
    }
    if (type.isUnion()) {
      const members = type.types.filter(
        (member) =>
          !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
      );
      if (members.length === 1) {
        return stripNullish(members[0]);
      }
    }
    if (type.isIntersection()) {
      const shaped = type.types.filter((member) => !shapeless(member));
      if (shaped.length === 1) {
        return stripNullish(shaped[0]);
      }
    }
    return type;
  }

  function claimContract(contract, options = {}) {
    if (!contract) {
      return null;
    }
    const core = stripNullish(contract);
    if (core.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(core);
      if (constraint && constraint !== core) {
        return claimContract(constraint, options);
      }
      return options.allowTypeParameter ? core : null;
    }
    return typed(contract, options) || unresolvedType(contract)
      ? contract
      : null;
  }

  return {
    accessKey,
    accessKeys,
    claimContract,
    elementContract,
    memberContract,
    projectContract,
    propertyKey,
    propertyKeys,
  };
}
