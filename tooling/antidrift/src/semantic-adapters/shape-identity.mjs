import ts from "typescript";
import { dirname, join } from "node:path";

function readonlyProperty(property) {
  return Boolean(
    ts.getCheckFlags(property) & ts.CheckFlags.Readonly ||
    ts.getDeclarationModifierFlagsFromSymbol(property) &
      ts.ModifierFlags.Readonly ||
    (property.flags & ts.SymbolFlags.GetAccessor &&
      !(property.flags & ts.SymbolFlags.SetAccessor))
  );
}

export function sameObjectShape(type, owner, checker) {
  let compared = new Map();
  function samePredicate(signature, owner) {
    const predicate = checker.getTypePredicateOfSignature(signature);
    const ownedPredicate = checker.getTypePredicateOfSignature(owner);
    if (!predicate || !ownedPredicate) return predicate === ownedPredicate;
    return (
      predicate.kind === ownedPredicate.kind &&
      predicate.parameterIndex === ownedPredicate.parameterIndex &&
      (predicate.type && ownedPredicate.type
        ? sameType(predicate.type, ownedPredicate.type)
        : predicate.type === ownedPredicate.type)
    );
  }

  function sameSignature(signature, owner) {
    if (
      signature.parameters.length !== owner.parameters.length ||
      signature.minArgumentCount !== owner.minArgumentCount ||
      signature.flags !== owner.flags ||
      (signature.typeParameters?.length ?? 0) !==
        (owner.typeParameters?.length ?? 0)
    ) {
      return false;
    }
    const typeParameters = signature.typeParameters ?? [];
    const ownedParameters = owner.typeParameters ?? [];
    const previousComparisons = compared;
    compared = new Map(compared);
    try {
      for (const [index, parameter] of typeParameters.entries()) {
        compared.set(parameter, new Set([ownedParameters[index]]));
      }
      for (const [index, parameter] of typeParameters.entries()) {
        for (const field of ["getConstraint", "getDefault"]) {
          const contract = parameter[field]();
          const ownedContract = ownedParameters[index][field]();
          if (Boolean(contract) !== Boolean(ownedContract)) return false;
          if (contract && !sameType(contract, ownedContract)) {
            return false;
          }
        }
      }
      if (!samePredicate(signature, owner)) return false;
      if (Boolean(signature.thisParameter) !== Boolean(owner.thisParameter)) {
        return false;
      }
      if (
        signature.thisParameter &&
        !sameType(
          checker.getTypeOfSymbol(signature.thisParameter),
          checker.getTypeOfSymbol(owner.thisParameter)
        )
      ) {
        return false;
      }
      if (
        !sameType(
          checker.getReturnTypeOfSignature(signature),
          checker.getReturnTypeOfSignature(owner)
        )
      ) {
        return false;
      }
      return signature.parameters.every((parameter, index) =>
        sameType(
          checker.getTypeOfSymbol(parameter),
          checker.getTypeOfSymbol(owner.parameters[index])
        )
      );
    } finally {
      compared = previousComparisons;
    }
  }

  function sameArray(type, owner) {
    if (checker.isTupleType(type) !== checker.isTupleType(owner)) {
      return false;
    }
    if (checker.isArrayType(type) && type.target !== owner.target) {
      return false;
    }
    if (type.target.readonly !== owner.target.readonly) return false;
    if (
      checker.isTupleType(type) &&
      JSON.stringify(type.target.elementFlags) !==
        JSON.stringify(owner.target.elementFlags)
    ) {
      return false;
    }
    const elements = checker.getTypeArguments(type);
    const ownedElements = checker.getTypeArguments(owner);
    return (
      elements.length === ownedElements.length &&
      elements.every((element, index) =>
        sameType(element, ownedElements[index])
      )
    );
  }

  function sameKnownType(type) {
    if (type.isUnionOrIntersection()) {
      return type.types.every((member) => sameType(member, member));
    }
    if (
      type.aliasTypeArguments?.some((argument) => !sameType(argument, argument))
    ) {
      return false;
    }
    if (type.objectFlags & ts.ObjectFlags.Reference) {
      return checker
        .getTypeArguments(type)
        .every((argument) => sameType(argument, argument));
    }
    return true;
  }

  function sameReferenceTarget(type, owner) {
    return Boolean(
      type.objectFlags & ts.ObjectFlags.Reference &&
      owner.objectFlags & ts.ObjectFlags.Reference &&
      type.target === owner.target
    );
  }

  function sameReferenceArguments(type, owner) {
    const typeArguments = checker.getTypeArguments(type);
    const ownedArguments = checker.getTypeArguments(owner);
    return (
      typeArguments.length === ownedArguments.length &&
      typeArguments.every((argument, index) =>
        sameType(argument, ownedArguments[index])
      )
    );
  }

  function sameType(type, owner) {
    if (
      [type, owner].some(
        (candidate) =>
          candidate.flags & ts.TypeFlags.Any ||
          candidate.intrinsicName === "error"
      )
    ) {
      return false;
    }
    if (compared.get(type)?.has(owner)) return true;
    if (
      !checker.isTypeAssignableTo(type, owner) ||
      !checker.isTypeAssignableTo(owner, type)
    ) {
      return false;
    }
    const previousComparisons = compared;
    compared = new Map(compared);
    try {
      compared.set(type, new Set([...(compared.get(type) ?? []), owner]));
      if (type === owner) return sameKnownType(type);
      if (sameReferenceTarget(type, owner)) {
        return sameReferenceArguments(type, owner);
      }
      if (type.isUnionOrIntersection() || owner.isUnionOrIntersection()) {
        if (
          type.flags !== owner.flags ||
          type.types.length !== owner.types.length
        ) {
          return false;
        }
        return (
          type.types.every((member) =>
            owner.types.some((ownedMember) => sameType(member, ownedMember))
          ) &&
          owner.types.every((member) =>
            type.types.some((candidate) => sameType(candidate, member))
          )
        );
      }
      if (
        !(type.flags & ts.TypeFlags.Object) ||
        !(owner.flags & ts.TypeFlags.Object)
      ) {
        return type === owner;
      }
      const array = checker.isArrayType(type) || checker.isTupleType(type);
      const ownedArray =
        checker.isArrayType(owner) || checker.isTupleType(owner);
      if (array || ownedArray) {
        return array === ownedArray && sameArray(type, owner);
      }
      const properties = checker.getPropertiesOfType(type);
      const ownedProperties = checker.getPropertiesOfType(owner);
      if (properties.length !== ownedProperties.length) return false;
      if (
        !properties.every((property) => {
          const ownedProperty = checker.getPropertyOfType(owner, property.name);
          return (
            ownedProperty &&
            (property.flags & ts.SymbolFlags.Optional) ===
              (ownedProperty.flags & ts.SymbolFlags.Optional) &&
            readonlyProperty(property) === readonlyProperty(ownedProperty) &&
            sameType(
              checker.getTypeOfSymbol(property),
              checker.getTypeOfSymbol(ownedProperty)
            )
          );
        })
      ) {
        return false;
      }
      const indexes = checker.getIndexInfosOfType(type);
      const ownedIndexes = checker.getIndexInfosOfType(owner);
      if (
        indexes.length !== ownedIndexes.length ||
        !indexes.every((index) =>
          ownedIndexes.some(
            (ownedIndex) =>
              index.isReadonly === ownedIndex.isReadonly &&
              sameType(index.keyType, ownedIndex.keyType) &&
              sameType(index.type, ownedIndex.type)
          )
        )
      ) {
        return false;
      }
      return [ts.SignatureKind.Call, ts.SignatureKind.Construct].every(
        (kind) => {
          const signatures = checker.getSignaturesOfType(type, kind);
          const ownedSignatures = checker.getSignaturesOfType(owner, kind);
          return (
            signatures.length === ownedSignatures.length &&
            signatures.every((signature, index) =>
              sameSignature(signature, ownedSignatures[index])
            )
          );
        }
      );
    } finally {
      compared = previousComparisons;
    }
  }
  return (
    checker.isTypeAssignableTo(type, owner) &&
    checker.isTypeAssignableTo(owner, type) &&
    sameType(type, owner)
  );
}

export function packageDirectory(filename) {
  let directory = dirname(filename);
  while (!ts.sys.fileExists(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return directory;
}

const generatorHeader =
  /@generated\b|\bthis file (?:is|was) (?:auto-?)?generated\b|\b(?:auto|automatically)[- ]?generated\b|\bcode generated by\b|\bdo not edit\b/iu;

export function declaresGenerated(source) {
  return (ts.getLeadingCommentRanges(source.text, 0) ?? []).some((range) =>
    generatorHeader.test(source.text.slice(range.pos, range.end))
  );
}
