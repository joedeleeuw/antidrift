import ts from "typescript";

import { resolveAliasedSymbol } from "../provenance/symbol-provenance.ts";
import { boundedType, objectType } from "../shape/contract-types.ts";
import type { StructuralTypeCandidate } from "../type-owner.mjs";

type OwnerSource = {
  readonly authority: string;
  readonly label: string;
  readonly root: ts.Type;
};

export type OwnerProjection = {
  readonly type: ts.Type;
  readonly sources: ReadonlyMap<string, OwnerSource>;
  readonly roots: ReadonlySet<ts.Type>;
  readonly authority: string;
  readonly label: string;
};

type ProjectionVisit = {
  readonly checker: ts.TypeChecker;
  readonly owners: Map<ts.Type, OwnerProjection>;
  readonly authority: string;
  readonly root: ts.Type;
};

type ProjectionPath = {
  readonly label: string;
  readonly depth: number;
  readonly seen: ReadonlySet<ts.Type>;
};

export const maxOwnerDepth = 8;

export function nonNullable(
  checker: ts.TypeChecker,
  type: ts.Type | undefined
): ts.Type | undefined {
  return type && checker.getNonNullableType(type);
}

function sortedJoin(names: Iterable<string>): string {
  return [...new Set(names)].sort().join(" | ");
}

function visitOwnerProjection(
  visit: ProjectionVisit,
  ownedType: ts.Type,
  path: ProjectionPath
): void {
  if (!objectType(ownedType) || path.depth === 0 || path.seen.has(ownedType)) {
    return;
  }
  const sources = new Map(visit.owners.get(ownedType)?.sources ?? []);
  sources.set(`${visit.authority}:${path.label}`, {
    authority: visit.authority,
    label: path.label,
    root: visit.root,
  });
  const sourceList = [...sources.values()];
  visit.owners.set(ownedType, {
    type: ownedType,
    sources,
    roots: new Set(sourceList.map((source) => source.root)),
    authority: sortedJoin(sourceList.map((source) => source.authority)),
    label: sortedJoin(sourceList.map((source) => source.label)),
  });
  const seen = new Set([...path.seen, ownedType]);
  for (const property of visit.checker.getPropertiesOfType(ownedType)) {
    const propertyType = visit.checker.getTypeOfSymbol(property);
    visitOwnerProjection(
      visit,
      visit.checker.getNonNullableType(propertyType),
      {
        label: `${path.label}[${JSON.stringify(property.name)}]`,
        depth: path.depth - 1,
        seen,
      }
    );
  }
}

export function ownerProjections(
  checker: ts.TypeChecker,
  candidates: readonly StructuralTypeCandidate[]
) {
  const owners = new Map<ts.Type, OwnerProjection>();
  for (const candidate of candidates) {
    const root = candidate.type;
    if (candidate.authorityState === "accepted" && root) {
      visitOwnerProjection(
        { checker, owners, authority: candidate.authority, root },
        checker.getNonNullableType(root),
        { label: candidate.label, depth: maxOwnerDepth, seen: new Set() }
      );
    }
  }
  return owners;
}

export function contextualOwner(
  checker: ts.TypeChecker,
  owners: ReadonlyMap<ts.Type, OwnerProjection>,
  type: ts.Type | undefined
) {
  const contextualType = nonNullable(checker, type);
  const owner = contextualType && owners.get(contextualType);
  if (owner) {
    return owner;
  }
  if (!contextualType?.isUnion() || !boundedType(checker, contextualType)) {
    return null;
  }
  const objectConstituents = contextualType.types.filter(
    (part) =>
      (part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !== 0
  );
  const [soleConstituent] = objectConstituents;
  return objectConstituents.length === 1 && soleConstituent
    ? owners.get(soleConstituent)
    : null;
}

function ownerTypes(checker: ts.TypeChecker, owner: OwnerProjection) {
  const visited = new Set<ts.Type>();
  const visit = (type: ts.Type, depth: number): void => {
    if (depth === 0 || visited.has(type)) {
      return;
    }
    visited.add(type);
    if (!objectType(type)) {
      return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      visit(
        checker.getNonNullableType(checker.getTypeOfSymbol(property)),
        depth - 1
      );
    }
  };
  for (const root of owner.roots) {
    visit(root, maxOwnerDepth);
  }
  return visited;
}

function sharesOwnedDeclarations(
  checker: ts.TypeChecker,
  type: ts.Type,
  ownedTypes: ReadonlySet<ts.Type>
): boolean {
  const properties = checker.getPropertiesOfType(type);
  return (
    properties.length > 0 &&
    [...ownedTypes].some(
      (owned) =>
        objectType(owned) &&
        properties.every((property) => {
          const original = checker.getPropertyOfType(owned, property.name);
          const declarations = property.declarations ?? [];
          return (
            original !== undefined &&
            declarations.length > 0 &&
            declarations.every((declaration) =>
              original.declarations?.includes(declaration)
            )
          );
        })
    )
  );
}

function ownerReference(
  checker: ts.TypeChecker,
  node: ts.TypeNode | undefined,
  owner: OwnerProjection,
  seen: ReadonlySet<ts.Node> = new Set()
): boolean {
  if (!node || seen.has(node)) {
    return false;
  }
  const next = new Set([...seen, node]);
  if (ts.isParenthesizedTypeNode(node)) {
    return ownerReference(checker, node.type, owner, next);
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    return ownerReference(checker, node.objectType, owner, next);
  }
  if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) {
    return false;
  }
  const type = checker.getTypeFromTypeNode(node);
  const ownedTypes = ownerTypes(checker, owner);
  if ((objectType(type) || type.aliasSymbol) && ownedTypes.has(type)) {
    return true;
  }
  if (sharesOwnedDeclarations(checker, type, ownedTypes)) {
    return true;
  }
  const referenced = resolveAliasedSymbol(
    checker,
    ts.isTypeReferenceNode(node)
      ? checker.getSymbolAtLocation(node.typeName)
      : type.aliasSymbol
  );
  return (referenced?.declarations ?? []).some(
    (declaration) =>
      ts.isTypeAliasDeclaration(declaration) &&
      ownerReference(checker, declaration.type, owner, next)
  );
}

export function derivedComposition(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  owner: OwnerProjection
): boolean {
  if (ownerReference(checker, node, owner)) {
    return true;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return derivedComposition(checker, node.type, owner);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.every((part) => derivedComposition(checker, part, owner));
  }
  if (ts.isTypeLiteralNode(node)) {
    return (
      node.members.length > 0 &&
      node.members.every((member) => {
        const memberType = ts.hasType(member) ? member.type : undefined;
        return (
          memberType !== undefined &&
          derivedComposition(checker, memberType, owner)
        );
      })
    );
  }
  return false;
}
