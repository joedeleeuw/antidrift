import ts from "typescript";

import { isTypeReference } from "../kernel/typescript-internals.ts";

import { broad } from "./boundary-types.ts";
import { boundaryObservations } from "./boundary-observations.ts";
import { collectionCases, nonForwardingOutputCases } from "./decision-cases.ts";

export const RETURNED_FUNCTION_DEPTH =
  boundaryObservations.bounds.returnedFunctionDepth.limit;

type PendingType = readonly [ts.Type | undefined, number];

export type TypeParameterSet = ReadonlySet<ts.Type>;

export type CollectionMatch = {
  readonly shared: TypeParameterSet;
  readonly sourceIsCollection: boolean;
};

export function isNonForwardingReturn(returned: ts.Type | undefined): boolean {
  if (!returned) {
    return true;
  }
  return nonForwardingOutputCases.some((row) => {
    if ("property" in row) {
      return Boolean(returned[row.property]);
    }
    if ("numeric" in row) {
      return (
        (returned.flags &
          (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !==
        0
      );
    }
    return (returned.flags & ts.TypeFlags.Void) !== 0;
  });
}

export function enclosingTypeParameters(declaration: ts.Node | undefined) {
  const owner = declaration?.parent;
  return owner &&
    (ts.isFunctionLike(owner) ||
      ts.isClassLike(owner) ||
      ts.isInterfaceDeclaration(owner) ||
      ts.isTypeAliasDeclaration(owner) ||
      ts.isJSDocTemplateTag(owner))
    ? owner.typeParameters
    : undefined;
}

function declaredConstraint(type: ts.Type) {
  const declaration = type.getSymbol()?.declarations?.[0];
  return declaration && ts.isTypeParameterDeclaration(declaration)
    ? declaration.constraint
    : undefined;
}

export class TypeParameterFlow {
  readonly #checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  broadPayload(
    type: ts.Type | undefined,
    visited = new Set<ts.Type>()
  ): boolean {
    if (!type || visited.has(type)) {
      return false;
    }
    visited.add(type);
    if (broad(type)) {
      return true;
    }
    if (type.isUnion()) {
      return type.types.some((member) => this.broadPayload(member, visited));
    }
    if (this.#checker.isArrayType(type) || this.#checker.isTupleType(type)) {
      return this.#checker
        .getTypeArguments(type)
        .some((argument) => this.broadPayload(argument, visited));
    }
    return false;
  }

  returnedTypeParameters(returned: ts.Type | undefined) {
    const typeParameters = new Set<ts.Type>();
    const visited = new Set<ts.Type>();
    let truncated = false;
    const pending: PendingType[] = [[returned, 0]];
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [current, depth] = next;
      if (!current || visited.has(current)) {
        continue;
      }
      if (depth > RETURNED_FUNCTION_DEPTH) {
        truncated = true;
        continue;
      }
      visited.add(current);
      if (current.flags & ts.TypeFlags.TypeParameter && !current.isThisType) {
        typeParameters.add(current);
        const constraintNode = declaredConstraint(current);
        const constraint =
          constraintNode && this.#checker.getTypeFromTypeNode(constraintNode);
        if (
          constraint &&
          constraint.flags & ts.TypeFlags.TypeParameter &&
          !constraint.isThisType
        ) {
          pending.push([constraint, depth]);
        }
      }
      this.#enqueueCompositeChildren(current, depth, pending);
      for (const signature of current.getCallSignatures()) {
        pending.push([
          this.#checker.getReturnTypeOfSignature(signature),
          depth + 1,
        ]);
      }
    }
    return { typeParameters, truncated };
  }

  sharedTypeParameters(
    type: ts.Type | undefined,
    targetSet: TypeParameterSet | undefined
  ) {
    const shared = new Set<ts.Type>();
    if (!type || !targetSet?.size) {
      return shared;
    }
    for (const candidate of this.returnedTypeParameters(type).typeParameters) {
      if (targetSet.has(candidate)) {
        shared.add(candidate);
      }
    }
    return shared;
  }

  isCollectionOver(
    type: ts.Type | undefined,
    targetSet: TypeParameterSet | undefined
  ): boolean {
    if (!type || !targetSet?.size) {
      return false;
    }
    const nonNull = type.getNonNullableType();
    if (nonNull.isUnion()) {
      return nonNull.types.some((member) =>
        this.isCollectionOver(member, targetSet)
      );
    }
    const elements = this.#collectionElements(nonNull);
    if (elements.length) {
      return elements.some(
        (element) => this.sharedTypeParameters(element, targetSet).size > 0
      );
    }
    if (nonNull.templateType && nonNull.constraintType) {
      return (
        this.sharedTypeParameters(nonNull.templateType, targetSet).size > 0
      );
    }
    const promised = this.#checker.getPromisedTypeOfPromise(nonNull);
    return Boolean(
      promised &&
      promised !== nonNull &&
      this.isCollectionOver(promised, targetSet)
    );
  }

  sharedCallbackOutput(
    callables: readonly ts.Signature[],
    targetSet: TypeParameterSet
  ): CollectionMatch {
    const shared = new Set<ts.Type>();
    let sourceIsCollection = false;
    for (const signature of callables) {
      const callbackReturn = this.#checker.getReturnTypeOfSignature(signature);
      const callbackShared = this.sharedTypeParameters(
        callbackReturn,
        targetSet
      );
      if (callbackShared.size) {
        for (const parameterType of callbackShared) {
          shared.add(parameterType);
        }
        if (this.isCollectionOver(callbackReturn, callbackShared)) {
          sourceIsCollection = true;
        }
      }
    }
    return { shared, sourceIsCollection };
  }

  receiverSharedParameters(
    declaration: NonNullable<ts.Signature["declaration"]>,
    declaredSignature: ts.Signature,
    targetSet: TypeParameterSet
  ): CollectionMatch {
    const parentParameters =
      enclosingTypeParameters(declaration)?.map((parameter) =>
        this.#checker.getTypeAtLocation(parameter)
      ) ?? [];
    const sharedParent = new Set(
      parentParameters.filter((parameter) => targetSet.has(parameter))
    );
    if (sharedParent.size) {
      const owner = declaration.parent;
      const parentName = ts.isNamedDeclaration(owner)
        ? owner.name.getText(declaration.getSourceFile())
        : null;
      const collectionRow = collectionCases.find(
        (row) => parentName !== null && row.symbols.includes(parentName)
      );
      const elementParameter = collectionRow
        ? (parentParameters[collectionRow.elementIndex] ?? parentParameters[0])
        : null;
      return {
        shared: sharedParent,
        sourceIsCollection: Boolean(
          elementParameter && sharedParent.has(elementParameter)
        ),
      };
    }
    const thisContract =
      declaredSignature.thisParameter &&
      this.#checker.getTypeOfSymbol(declaredSignature.thisParameter);
    const sharedThis = this.sharedTypeParameters(thisContract, targetSet);
    return {
      shared: sharedThis,
      sourceIsCollection: this.isCollectionOver(thisContract, sharedThis),
    };
  }

  #enqueueCompositeChildren(
    current: ts.Type,
    depth: number,
    pending: PendingType[]
  ): void {
    const members = current.isUnionOrIntersection() ? current.types : [];
    const aliasArguments = current.aliasTypeArguments ?? [];
    for (const member of [
      ...members,
      ...(isTypeReference(current)
        ? this.#checker.getTypeArguments(current)
        : []),
      ...aliasArguments,
    ]) {
      pending.push([member, depth]);
    }
    for (const indexSignature of this.#checker.getIndexInfosOfType(current)) {
      pending.push([indexSignature.type, depth]);
    }
    const symbolDeclaration = current.getSymbol()?.declarations?.[0];
    if (symbolDeclaration && ts.isTypeLiteralNode(symbolDeclaration)) {
      for (const property of this.#checker.getPropertiesOfType(current)) {
        pending.push([this.#checker.getTypeOfSymbol(property), depth]);
      }
    }
    for (const compositeChild of [
      current.templateType,
      current.objectType,
      current.indexType,
    ]) {
      if (compositeChild) {
        pending.push([compositeChild, depth]);
      }
    }
  }

  #collectionElements(type: ts.Type): readonly ts.Type[] {
    const nonNull = type.getNonNullableType();
    const symbolName =
      nonNull.getSymbol()?.name ?? nonNull.target?.getSymbol()?.name ?? null;
    const collectionRow = collectionCases.find(
      (row) => symbolName !== null && row.symbols.includes(symbolName)
    );
    if (collectionRow) {
      const typeArguments = this.#checker.getTypeArguments(nonNull);
      const element = typeArguments[collectionRow.elementIndex];
      return element ? [element] : typeArguments;
    }
    if (
      this.#checker.isArrayLikeType(nonNull) &&
      !this.#checker.isTupleType(nonNull)
    ) {
      const indexed = this.#checker.getIndexTypeOfType(
        nonNull,
        ts.IndexKind.Number
      );
      return indexed ? [indexed] : this.#checker.getTypeArguments(nonNull);
    }
    return [];
  }
}
