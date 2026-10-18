import { relative } from "node:path";
import ts from "typescript";

import {
  isErrorType,
  isReadonlyProperty,
  isTypeReference,
} from "../kernel/typescript-internals.ts";

type UnresolvedShape = {
  readonly path: readonly string[];
  readonly declarations: readonly ts.Declaration[];
};

type ShapeVerdict = boolean | UnresolvedShape;

type ShapeComparisonState = {
  readonly checker: ts.TypeChecker;
  compared: Map<ts.Type, Set<ts.Type>>;
};

const comparedSignatureKinds = [
  ts.SignatureKind.Call,
  ts.SignatureKind.Construct,
] as const;

const typeParameterContracts = ["getConstraint", "getDefault"] as const;

function everyComparison<Comparand>(
  comparands: readonly Comparand[],
  compare: (comparand: Comparand, index: number) => ShapeVerdict
): ShapeVerdict {
  let undecided: UnresolvedShape | null = null;
  for (const [index, comparand] of comparands.entries()) {
    const verdict = compare(comparand, index);
    if (verdict === false) {
      return false;
    }
    if (verdict !== true) {
      undecided ??= verdict;
    }
  }
  return undecided ?? true;
}

function anyComparison<Comparand>(
  comparands: readonly Comparand[],
  compare: (comparand: Comparand, index: number) => ShapeVerdict
): ShapeVerdict {
  let undecided: UnresolvedShape | null = null;
  for (const [index, comparand] of comparands.entries()) {
    const verdict = compare(comparand, index);
    if (verdict === true) {
      return true;
    }
    if (verdict !== false) {
      undecided ??= verdict;
    }
  }
  return undecided ?? false;
}

function unresolvedReference(
  node: ts.Node,
  checker: ts.TypeChecker
): ts.TypeReferenceNode | undefined {
  if (
    ts.isTypeReferenceNode(node) &&
    isErrorType(checker.getTypeFromTypeNode(node))
  ) {
    return node;
  }
  return ts.forEachChild(node, (child) => unresolvedReference(child, checker));
}

function importedSpecifier(imported: ts.Declaration): string | null {
  const declaration = ts.findAncestor(imported, ts.isImportDeclaration);
  return declaration && ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : null;
}

export function unresolvedDescription(
  verdict: UnresolvedShape,
  checker: ts.TypeChecker,
  cwd: string
): string {
  const where =
    verdict.path.length > 0 ? ` at property ${verdict.path.join(".")}` : "";
  const reference = verdict.declarations
    .flatMap((declaration) =>
      ts.hasType(declaration) && declaration.type ? [declaration.type] : []
    )
    .map((typeNode) => unresolvedReference(typeNode, checker))
    .find((candidate) => candidate !== undefined);
  if (!reference) {
    return `a type${where}`;
  }
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
  const specifier = imported ? importedSpecifier(imported) : null;
  if (specifier === null) {
    return `${name} (${location})${where}`;
  }
  return `${name} imported from '${specifier}' (${location})${where}`;
}

function withScopedComparisons(
  state: ShapeComparisonState,
  compare: () => ShapeVerdict
): ShapeVerdict {
  const previousComparisons = state.compared;
  state.compared = new Map(
    [...previousComparisons].map(([left, rights]) => [left, new Set(rights)])
  );
  try {
    return compare();
  } finally {
    state.compared = previousComparisons;
  }
}

function instantiated(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    (type.aliasTypeArguments?.length ?? 0) > 0 ||
    (isTypeReference(type) && checker.getTypeArguments(type).length > 0)
  );
}

function samePredicate(
  state: ShapeComparisonState,
  signature: ts.Signature,
  owner: ts.Signature
): ShapeVerdict {
  const predicate = state.checker.getTypePredicateOfSignature(signature);
  const ownedPredicate = state.checker.getTypePredicateOfSignature(owner);
  if (!predicate || !ownedPredicate) {
    return predicate === ownedPredicate;
  }
  if (
    predicate.kind !== ownedPredicate.kind ||
    predicate.parameterIndex !== ownedPredicate.parameterIndex
  ) {
    return false;
  }
  return predicate.type && ownedPredicate.type
    ? sameType(state, predicate.type, ownedPredicate.type)
    : predicate.type === ownedPredicate.type;
}

function sameTypeParameters(
  state: ShapeComparisonState,
  signature: ts.Signature,
  owner: ts.Signature
): ShapeVerdict {
  const ownedParameters = owner.typeParameters ?? [];
  const typeParameters = signature.typeParameters ?? [];
  for (const [index, parameter] of typeParameters.entries()) {
    const ownedParameter = ownedParameters[index];
    if (ownedParameter) {
      state.compared.set(parameter, new Set([ownedParameter]));
    }
  }
  return everyComparison(typeParameters, (parameter, index) => {
    const ownedParameter = ownedParameters[index];
    if (!ownedParameter) {
      return false;
    }
    return everyComparison(typeParameterContracts, (field) => {
      const contract = parameter[field]();
      const ownedContract = ownedParameter[field]();
      return contract && ownedContract
        ? sameType(state, contract, ownedContract)
        : contract === ownedContract;
    });
  });
}

function sameSignature(
  state: ShapeComparisonState,
  signature: ts.Signature,
  owner: ts.Signature
): ShapeVerdict {
  const { checker } = state;
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
  return withScopedComparisons(state, () =>
    everyComparison(
      [
        () => sameTypeParameters(state, signature, owner),
        () => samePredicate(state, signature, owner),
        () =>
          !signature.thisParameter ||
          !owner.thisParameter ||
          sameType(
            state,
            checker.getTypeOfSymbol(signature.thisParameter),
            checker.getTypeOfSymbol(owner.thisParameter)
          ),
        () =>
          sameType(
            state,
            checker.getReturnTypeOfSignature(signature),
            checker.getReturnTypeOfSignature(owner)
          ),
        () =>
          everyComparison(signature.parameters, (parameter, index) => {
            const ownedParameter = owner.parameters[index];
            return (
              ownedParameter !== undefined &&
              sameType(
                state,
                checker.getTypeOfSymbol(parameter),
                checker.getTypeOfSymbol(ownedParameter)
              )
            );
          }),
      ],
      (compare) => compare()
    )
  );
}

function sameArrayKind(
  checker: ts.TypeChecker,
  type: ts.TypeReference,
  owner: ts.TypeReference
): boolean {
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

function sameReferenceTarget(type: ts.Type, owner: ts.Type): boolean {
  return (
    isTypeReference(type) &&
    isTypeReference(owner) &&
    type.target === owner.target
  );
}

function samePropertyMembers(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const { checker } = state;
  return everyComparison(checker.getPropertiesOfType(type), (property) => {
    const ownedProperty = checker.getPropertyOfType(owner, property.name);
    if (
      !ownedProperty ||
      (property.flags & ts.SymbolFlags.Optional) !==
        (ownedProperty.flags & ts.SymbolFlags.Optional) ||
      isReadonlyProperty(property) !== isReadonlyProperty(ownedProperty)
    ) {
      return false;
    }
    const verdict = sameType(
      state,
      checker.getTypeOfSymbol(property),
      checker.getTypeOfSymbol(ownedProperty)
    );
    if (typeof verdict === "boolean") {
      return verdict;
    }
    return {
      path: [property.name, ...verdict.path],
      declarations:
        verdict.path.length > 0
          ? verdict.declarations
          : [property, ownedProperty].flatMap(
              (side) => side.valueDeclaration ?? []
            ),
    };
  });
}

function sameIndexMembers(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const ownedIndexes = state.checker.getIndexInfosOfType(owner);
  return everyComparison(state.checker.getIndexInfosOfType(type), (index) =>
    anyComparison(
      ownedIndexes,
      (ownedIndex) =>
        index.isReadonly === ownedIndex.isReadonly &&
        everyComparison(
          [
            [index.keyType, ownedIndex.keyType],
            [index.type, ownedIndex.type],
          ] as const,
          ([left, right]) => sameType(state, left, right)
        )
    )
  );
}

function sameSignatureMembers(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  return everyComparison(comparedSignatureKinds, (kind) => {
    const ownedSignatures = state.checker.getSignaturesOfType(owner, kind);
    return everyComparison(
      state.checker.getSignaturesOfType(type, kind),
      (signature, index) => {
        const ownedSignature = ownedSignatures[index];
        return (
          ownedSignature !== undefined &&
          sameSignature(state, signature, ownedSignature)
        );
      }
    );
  });
}

function sameMembers(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const { checker } = state;
  if (
    checker.getPropertiesOfType(type).length !==
      checker.getPropertiesOfType(owner).length ||
    checker.getIndexInfosOfType(type).length !==
      checker.getIndexInfosOfType(owner).length ||
    comparedSignatureKinds.some(
      (kind) =>
        checker.getSignaturesOfType(type, kind).length !==
        checker.getSignaturesOfType(owner, kind).length
    )
  ) {
    return false;
  }
  return everyComparison(
    [
      () => samePropertyMembers(state, type, owner),
      () => sameIndexMembers(state, type, owner),
      () => sameSignatureMembers(state, type, owner),
    ],
    (compare) => compare()
  );
}

function everyMemberMatched(
  state: ShapeComparisonState,
  type: ts.UnionOrIntersectionType,
  owner: ts.UnionOrIntersectionType
): ShapeVerdict {
  return everyComparison(
    [
      [type.types, owner.types],
      [owner.types, type.types],
    ] as const,
    ([members, candidates]) =>
      everyComparison(members, (member) =>
        anyComparison(candidates, (candidate) =>
          members === type.types
            ? sameType(state, member, candidate)
            : sameType(state, candidate, member)
        )
      )
  );
}

function sameTypeArguments(
  state: ShapeComparisonState,
  typeArguments: readonly ts.Type[],
  ownedArguments: readonly ts.Type[]
): ShapeVerdict {
  if (typeArguments.length !== ownedArguments.length) {
    return false;
  }
  return everyComparison(typeArguments, (argument, index) => {
    const ownedArgument = ownedArguments[index];
    return (
      ownedArgument !== undefined && sameType(state, argument, ownedArgument)
    );
  });
}

function sameReferenceStructure(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const { checker } = state;
  const array = checker.isArrayType(type) || checker.isTupleType(type);
  const ownedArray = checker.isArrayType(owner) || checker.isTupleType(owner);
  if (!isTypeReference(type) || !isTypeReference(owner)) {
    return false;
  }
  if (
    !sameReferenceTarget(type, owner) &&
    !(array === ownedArray && sameArrayKind(checker, type, owner))
  ) {
    return false;
  }
  return sameTypeArguments(
    state,
    checker.getTypeArguments(type),
    checker.getTypeArguments(owner)
  );
}

function sameStructure(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const { checker } = state;
  const aliasArguments = type.aliasTypeArguments ?? [];
  const ownedAliasArguments = owner.aliasTypeArguments ?? [];
  if (
    aliasArguments.length > 0 &&
    type.aliasSymbol === owner.aliasSymbol &&
    aliasArguments.length === ownedAliasArguments.length
  ) {
    return sameTypeArguments(state, aliasArguments, ownedAliasArguments);
  }
  if (
    sameReferenceTarget(type, owner) ||
    [type, owner].some(
      (side) => checker.isArrayType(side) || checker.isTupleType(side)
    )
  ) {
    return sameReferenceStructure(state, type, owner);
  }
  if (type.isUnionOrIntersection() || owner.isUnionOrIntersection()) {
    return (
      type.isUnionOrIntersection() &&
      owner.isUnionOrIntersection() &&
      type.flags === owner.flags &&
      type.types.length === owner.types.length &&
      everyMemberMatched(state, type, owner)
    );
  }
  if (
    (type.flags & ts.TypeFlags.Object) === 0 ||
    (owner.flags & ts.TypeFlags.Object) === 0
  ) {
    return false;
  }
  return sameMembers(state, type, owner);
}

function sameType(
  state: ShapeComparisonState,
  type: ts.Type,
  owner: ts.Type
): ShapeVerdict {
  const { checker } = state;
  if ([type, owner].some(isErrorType)) {
    return { path: [], declarations: [] };
  }
  if ([type, owner].some((side) => (side.flags & ts.TypeFlags.Any) !== 0)) {
    return false;
  }
  if (state.compared.get(type)?.has(owner)) {
    return true;
  }
  if (type === owner && !instantiated(checker, type)) {
    return true;
  }
  if (
    !checker.isTypeAssignableTo(type, owner) ||
    !checker.isTypeAssignableTo(owner, type)
  ) {
    return false;
  }
  return withScopedComparisons(state, () => {
    state.compared.set(
      type,
      new Set([...(state.compared.get(type) ?? []), owner])
    );
    return sameStructure(state, type, owner);
  });
}

export function shapeComparison(
  program: ts.Program
): (type: ts.Type, owner: ts.Type) => ShapeVerdict {
  const state: ShapeComparisonState = {
    checker: program.getTypeChecker(),
    compared: new Map(),
  };
  return (type, owner) => sameType(state, type, owner);
}
