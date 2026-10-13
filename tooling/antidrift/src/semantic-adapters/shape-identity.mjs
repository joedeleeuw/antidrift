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

const cleanTypes = new WeakSet();
const uncheckedTypes = new WeakSet();

function defaultLibraryType(type, program) {
  const declarations = type.symbol?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    )
  );
}

function referencedTypes(type, program) {
  const checker = program.getTypeChecker();
  const referenced = [...(type.aliasTypeArguments ?? [])];
  if (type.isUnionOrIntersection()) referenced.push(...type.types);
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = type.getConstraint();
    if (constraint) referenced.push(constraint);
  }
  if (!(type.flags & ts.TypeFlags.Object)) return referenced;
  if (type.objectFlags & ts.ObjectFlags.Reference) {
    referenced.push(...checker.getTypeArguments(type));
  }
  if (defaultLibraryType(type, program)) return referenced;
  for (const property of checker.getPropertiesOfType(type)) {
    referenced.push(checker.getTypeOfSymbol(property));
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    referenced.push(index.keyType, index.type);
  }
  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
    for (const signature of checker.getSignaturesOfType(type, kind)) {
      referenced.push(checker.getReturnTypeOfSignature(signature));
      const predicate = checker.getTypePredicateOfSignature(signature);
      if (predicate?.type) referenced.push(predicate.type);
      for (const parameter of [
        ...(signature.thisParameter ? [signature.thisParameter] : []),
        ...signature.parameters,
      ]) {
        referenced.push(checker.getTypeOfSymbol(parameter));
      }
      for (const parameter of signature.typeParameters ?? []) {
        referenced.push(parameter);
      }
    }
  }
  return referenced;
}

function reachesUncheckedType(type, program) {
  const visited = new Set();
  const pending = [type];
  while (pending.length > 0) {
    const current = pending.pop();
    if (uncheckedTypes.has(current)) {
      uncheckedTypes.add(type);
      return true;
    }
    if (cleanTypes.has(current) || visited.has(current)) continue;
    if (current.flags & ts.TypeFlags.Any) {
      uncheckedTypes.add(type);
      return true;
    }
    visited.add(current);
    pending.push(...referencedTypes(current, program));
  }
  for (const clean of visited) cleanTypes.add(clean);
  return false;
}

export function sameObjectShape(type, owner, program) {
  const checker = program.getTypeChecker();
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

  function sameReferenceTarget(type, owner) {
    return Boolean(
      type.objectFlags & ts.ObjectFlags.Reference &&
      owner.objectFlags & ts.ObjectFlags.Reference &&
      type.target === owner.target
    );
  }

  function sameReference(type, owner) {
    const typeArguments = checker.getTypeArguments(type);
    const ownedArguments = checker.getTypeArguments(owner);
    return (
      !reachesUncheckedType(type, program) &&
      !reachesUncheckedType(owner, program) &&
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
      if (type === owner) return !reachesUncheckedType(type, program);
      if (sameReferenceTarget(type, owner)) return sameReference(type, owner);
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

const generationDeclarations = [
  /@generated\b/u,
  /^code generated\b.*\bdo not edit\.?$/iu,
  /^(?:this (?:file|module) (?:is|was|has been) )?(?:auto(?:matically)?[- ]?)?generated (?:by|from|with|using) \S/iu,
];

function commentLines(text) {
  return text
    .replace(/^\/\*+|\*+\/$/gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)?\s*/u, "").trim());
}

export function declaresGenerated(source) {
  return (ts.getLeadingCommentRanges(source.text, 0) ?? []).some((range) =>
    commentLines(source.text.slice(range.pos, range.end)).some((line) =>
      generationDeclarations.some((declaration) => declaration.test(line))
    )
  );
}
