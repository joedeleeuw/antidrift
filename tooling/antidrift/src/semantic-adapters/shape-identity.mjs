import ts from "typescript";
import { dirname, join, relative } from "node:path";

function readonlyProperty(property) {
  return Boolean(
    ts.getCheckFlags(property) & ts.CheckFlags.Readonly ||
    ts.getDeclarationModifierFlagsFromSymbol(property) &
      ts.ModifierFlags.Readonly ||
    (property.flags & ts.SymbolFlags.GetAccessor &&
      !(property.flags & ts.SymbolFlags.SetAccessor))
  );
}

function everyComparison(comparands, compare) {
  let undecided = null;
  for (const [index, comparand] of comparands.entries()) {
    const verdict = compare(comparand, index);
    if (verdict === false) return false;
    if (verdict !== true) undecided ??= verdict;
  }
  return undecided ?? true;
}

function anyComparison(comparands, compare) {
  let undecided = null;
  for (const [index, comparand] of comparands.entries()) {
    const verdict = compare(comparand, index);
    if (verdict === true) return true;
    if (verdict !== false) undecided ??= verdict;
  }
  return undecided ?? false;
}

function unresolvedReference(node, checker) {
  if (
    ts.isTypeReferenceNode(node) &&
    checker.getTypeFromTypeNode(node).intrinsicName === "error"
  ) {
    return node;
  }
  return ts.forEachChild(node, (child) => unresolvedReference(child, checker));
}

export function unresolvedDescription(verdict, checker, cwd) {
  const where =
    verdict.path.length > 0 ? ` at property ${verdict.path.join(".")}` : "";
  const reference = verdict.declarations
    .filter((declaration) => declaration.type)
    .map((declaration) => unresolvedReference(declaration.type, checker))
    .find(Boolean);
  if (!reference) return `a type${where}`;
  const imported = checker
    .getSymbolAtLocation(ts.getFirstIdentifier(reference.typeName))
    ?.declarations?.find(
      (declaration) =>
        ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)
    );
  const origin = imported ?? reference;
  const source = origin.getSourceFile();
  const line =
    source.getLineAndCharacterOfPosition(origin.getStart(source)).line + 1;
  const location = `${relative(cwd, source.fileName)}:${line}`;
  const name = reference.typeName.getText(reference.getSourceFile());
  if (!imported) return `${name} (${location})${where}`;
  const specifier = ts.findAncestor(imported, ts.isImportDeclaration)
    .moduleSpecifier.text;
  return `${name} imported from '${specifier}' (${location})${where}`;
}

export function shapeComparison(program) {
  const checker = program.getTypeChecker();
  let compared = new Map();
  function instantiated(type) {
    return Boolean(
      type.aliasTypeArguments?.length ||
      (type.objectFlags & ts.ObjectFlags.Reference &&
        checker.getTypeArguments(type).length > 0)
    );
  }
  function scopedComparisons() {
    const previousComparisons = compared;
    compared = new Map(
      [...compared].map(([left, rights]) => [left, new Set(rights)])
    );
    return previousComparisons;
  }

  function samePredicate(signature, owner) {
    const predicate = checker.getTypePredicateOfSignature(signature);
    const ownedPredicate = checker.getTypePredicateOfSignature(owner);
    if (!predicate || !ownedPredicate) return predicate === ownedPredicate;
    if (
      predicate.kind !== ownedPredicate.kind ||
      predicate.parameterIndex !== ownedPredicate.parameterIndex
    ) {
      return false;
    }
    return predicate.type && ownedPredicate.type
      ? sameType(predicate.type, ownedPredicate.type)
      : predicate.type === ownedPredicate.type;
  }

  function sameTypeParameters(signature, owner) {
    const ownedParameters = owner.typeParameters ?? [];
    const typeParameters = signature.typeParameters ?? [];
    for (const [index, parameter] of typeParameters.entries()) {
      compared.set(parameter, new Set([ownedParameters[index]]));
    }
    return everyComparison(typeParameters, (parameter, index) =>
      everyComparison(["getConstraint", "getDefault"], (field) => {
        const contract = parameter[field]();
        const ownedContract = ownedParameters[index][field]();
        return contract && ownedContract
          ? sameType(contract, ownedContract)
          : contract === ownedContract;
      })
    );
  }

  function sameSignature(signature, owner) {
    if (
      signature.parameters.length !== owner.parameters.length ||
      signature.minArgumentCount !== owner.minArgumentCount ||
      signature.flags !== owner.flags ||
      (signature.typeParameters?.length ?? 0) !==
        (owner.typeParameters?.length ?? 0) ||
      Boolean(signature.thisParameter) !== Boolean(owner.thisParameter)
    ) {
      return false;
    }
    const previousComparisons = scopedComparisons();
    try {
      return everyComparison(
        [
          () => sameTypeParameters(signature, owner),
          () => samePredicate(signature, owner),
          () =>
            !signature.thisParameter ||
            sameType(
              checker.getTypeOfSymbol(signature.thisParameter),
              checker.getTypeOfSymbol(owner.thisParameter)
            ),
          () =>
            sameType(
              checker.getReturnTypeOfSignature(signature),
              checker.getReturnTypeOfSignature(owner)
            ),
          () =>
            everyComparison(signature.parameters, (parameter, index) =>
              sameType(
                checker.getTypeOfSymbol(parameter),
                checker.getTypeOfSymbol(owner.parameters[index])
              )
            ),
        ],
        (compare) => compare()
      );
    } finally {
      compared = previousComparisons;
    }
  }

  function sameArrayKind(type, owner) {
    if (checker.isTupleType(type) !== checker.isTupleType(owner)) {
      return false;
    }
    if (checker.isArrayType(type) && type.target !== owner.target) {
      return false;
    }
    return (
      type.target.readonly === owner.target.readonly &&
      (!checker.isTupleType(type) ||
        JSON.stringify(type.target.elementFlags) ===
          JSON.stringify(owner.target.elementFlags))
    );
  }

  function sameReferenceTarget(type, owner) {
    return Boolean(
      type.objectFlags & ts.ObjectFlags.Reference &&
      owner.objectFlags & ts.ObjectFlags.Reference &&
      type.target === owner.target
    );
  }

  function sameMembers(type, owner) {
    const properties = checker.getPropertiesOfType(type);
    if (properties.length !== checker.getPropertiesOfType(owner).length) {
      return false;
    }
    const indexes = checker.getIndexInfosOfType(type);
    const ownedIndexes = checker.getIndexInfosOfType(owner);
    if (indexes.length !== ownedIndexes.length) return false;
    const kinds = [ts.SignatureKind.Call, ts.SignatureKind.Construct];
    if (
      kinds.some(
        (kind) =>
          checker.getSignaturesOfType(type, kind).length !==
          checker.getSignaturesOfType(owner, kind).length
      )
    ) {
      return false;
    }
    return everyComparison(
      [
        () =>
          everyComparison(properties, (property) => {
            const ownedProperty = checker.getPropertyOfType(
              owner,
              property.name
            );
            if (
              !ownedProperty ||
              (property.flags & ts.SymbolFlags.Optional) !==
                (ownedProperty.flags & ts.SymbolFlags.Optional) ||
              readonlyProperty(property) !== readonlyProperty(ownedProperty)
            ) {
              return false;
            }
            const verdict = sameType(
              checker.getTypeOfSymbol(property),
              checker.getTypeOfSymbol(ownedProperty)
            );
            if (typeof verdict === "boolean") return verdict;
            return {
              path: [property.name, ...verdict.path],
              declarations:
                verdict.path.length > 0
                  ? verdict.declarations
                  : [property, ownedProperty].flatMap(
                      (side) => side.valueDeclaration ?? []
                    ),
            };
          }),
        () =>
          everyComparison(indexes, (index) =>
            anyComparison(
              ownedIndexes,
              (ownedIndex) =>
                index.isReadonly === ownedIndex.isReadonly &&
                everyComparison(
                  [
                    [index.keyType, ownedIndex.keyType],
                    [index.type, ownedIndex.type],
                  ],
                  ([left, right]) => sameType(left, right)
                )
            )
          ),
        () =>
          everyComparison(kinds, (kind) => {
            const ownedSignatures = checker.getSignaturesOfType(owner, kind);
            return everyComparison(
              checker.getSignaturesOfType(type, kind),
              (signature, index) =>
                sameSignature(signature, ownedSignatures[index])
            );
          }),
      ],
      (compare) => compare()
    );
  }

  function everyMemberMatched(type, owner) {
    return everyComparison(
      [
        [type.types, owner.types],
        [owner.types, type.types],
      ],
      ([members, candidates]) =>
        everyComparison(members, (member) =>
          anyComparison(candidates, (candidate) =>
            members === type.types
              ? sameType(member, candidate)
              : sameType(candidate, member)
          )
        )
    );
  }

  function sameStructure(type, owner) {
    const aliasArguments = type.aliasTypeArguments ?? [];
    if (
      aliasArguments.length > 0 &&
      type.aliasSymbol === owner.aliasSymbol &&
      aliasArguments.length === (owner.aliasTypeArguments?.length ?? 0)
    ) {
      return everyComparison(aliasArguments, (argument, index) =>
        sameType(argument, owner.aliasTypeArguments[index])
      );
    }
    const array = checker.isArrayType(type) || checker.isTupleType(type);
    const ownedArray = checker.isArrayType(owner) || checker.isTupleType(owner);
    const reference = sameReferenceTarget(type, owner);
    if (reference || array || ownedArray) {
      if (!reference && !(array === ownedArray && sameArrayKind(type, owner))) {
        return false;
      }
      const typeArguments = checker.getTypeArguments(type);
      const ownedArguments = checker.getTypeArguments(owner);
      if (typeArguments.length !== ownedArguments.length) return false;
      return everyComparison(typeArguments, (argument, index) =>
        sameType(argument, ownedArguments[index])
      );
    }
    if (type.isUnionOrIntersection() || owner.isUnionOrIntersection()) {
      return (
        type.flags === owner.flags &&
        type.types.length === owner.types.length &&
        everyMemberMatched(type, owner)
      );
    }
    if (
      !(type.flags & ts.TypeFlags.Object) ||
      !(owner.flags & ts.TypeFlags.Object)
    ) {
      return false;
    }
    return sameMembers(type, owner);
  }

  function sameType(type, owner) {
    if ([type, owner].some((side) => side.intrinsicName === "error")) {
      return { path: [], declarations: [] };
    }
    if ([type, owner].some((side) => side.flags & ts.TypeFlags.Any)) {
      return false;
    }
    if (compared.get(type)?.has(owner)) return true;
    if (type === owner && !instantiated(type)) return true;
    if (
      !checker.isTypeAssignableTo(type, owner) ||
      !checker.isTypeAssignableTo(owner, type)
    ) {
      return false;
    }
    const previousComparisons = scopedComparisons();
    try {
      compared.set(type, new Set([...(compared.get(type) ?? []), owner]));
      return sameStructure(type, owner);
    } finally {
      compared = previousComparisons;
    }
  }
  return sameType;
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
  /^@generated\b/u,
  /^code generated\b.*\bdo not edit\.?$/iu,
  /^(?:this (?:(?:file|module) )?(?:is|was|has been) )?(?:auto(?:matically)?[- ]?)?generated (?:by|from|with|using) \S/iu,
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
