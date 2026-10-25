import ts from "typescript";

import { packageDirectory } from "../provenance/declared-dependencies.ts";
import { resolveAliasedSymbol } from "../provenance/symbol-provenance.ts";
import { boundedType, objectType } from "../shape/contract-types.ts";
import type {
  OwnerAuthority,
  OwnerCandidate,
  OwnerProjection,
  ProjectionRecord,
} from "./owner-projection-view.ts";
import { directOwnerReader, maxOwnerDepth } from "./owner-projection-view.ts";
import { pendingOwnerRoots } from "./owner-field-index.ts";
import type { CandidateRoot, OwnerFieldIndex } from "./owner-field-index.ts";

export type OwnerProjectionIndex = {
  readonly size: number;
  readonly unresolved: ReadonlySet<ts.Type>;
  getDirect(type: ts.Type): OwnerProjection | undefined;
  get(type: ts.Type): OwnerProjection | undefined;
};

type ProjectionVisit = OwnerAuthority & {
  readonly checker: ts.TypeChecker;
  readonly owners: Map<ts.Type, ProjectionRecord>;
  readonly root: ts.Type;
  readonly canVisit?: (type: ts.Type, depth: number) => boolean;
  readonly target?: ts.Type;
};

type ProjectionPath = {
  readonly label: string;
  readonly depth: number;
  readonly seen: ReadonlySet<ts.Type>;
};

export function nonNullable(
  checker: ts.TypeChecker,
  type: ts.Type | undefined
): ts.Type | undefined {
  return type && checker.getNonNullableType(type);
}

function declaredInPackage(
  type: ts.Type | undefined,
  packageRoot: string
): boolean {
  if (!type) {
    return false;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => declaredInPackage(part, packageRoot));
  }
  const declarations = [
    ...(type.aliasSymbol?.declarations ?? []),
    ...(type.getSymbol()?.declarations ?? []),
  ];
  return declarations.some(
    (declaration) =>
      packageDirectory(declaration.getSourceFile().fileName) === packageRoot
  );
}

function declaredInDefaultLibrary(type: ts.Type | undefined): boolean {
  if (!type) {
    return false;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => declaredInDefaultLibrary(part));
  }
  const declarations = [
    ...(type.aliasSymbol?.declarations ?? []),
    ...(type.getSymbol()?.declarations ?? []),
  ];
  return declarations.some(
    (declaration) =>
      declaration.getSourceFile().isDeclarationFile &&
      /(?:^|[/\\])lib\.[^/\\]*\.d\.ts$/u.test(
        declaration.getSourceFile().fileName
      )
  );
}

function visitOwnerProjection(
  visit: ProjectionVisit,
  ownedType: ts.Type,
  path: ProjectionPath
): boolean {
  if (
    visit.canVisit?.(ownedType, path.depth) === false ||
    !objectType(ownedType) ||
    path.depth === 0 ||
    path.seen.has(ownedType)
  ) {
    return false;
  }
  const sources = new Map(visit.owners.get(ownedType)?.sources ?? []);
  sources.set(`${visit.authority}:${path.label}`, {
    authority: visit.authority,
    label: path.label,
    root: visit.root,
    reverses: visit.reverses === true,
  });
  visit.owners.set(ownedType, { type: ownedType, sources });
  if (ownedType === visit.target) {
    return true;
  }
  if (path.depth === 1) {
    return false;
  }
  const seen = new Set([...path.seen, ownedType]);
  for (const property of visit.checker.getPropertiesOfType(ownedType)) {
    const propertyType = visit.checker.getTypeOfSymbol(property);
    if (
      visitOwnerProjection(
        visit,
        visit.checker.getNonNullableType(propertyType),
        {
          label: `${path.label}[${JSON.stringify(property.name)}]`,
          depth: path.depth - 1,
          seen,
        }
      )
    ) {
      return true;
    }
  }
  return false;
}

function rootOwners(
  checker: ts.TypeChecker,
  candidates: readonly OwnerCandidate[]
) {
  const owners = new Map<ts.Type, ProjectionRecord>();
  const roots = new Map<ts.Type, CandidateRoot[]>();
  for (const candidate of candidates) {
    if (candidate.authorityState !== "accepted" || !candidate.type) {
      continue;
    }
    const root = candidate.type;
    const ownedRoot = checker.getNonNullableType(root);
    if (!objectType(ownedRoot)) {
      continue;
    }
    visitOwnerProjection(
      {
        checker,
        owners,
        authority: candidate.authority,
        root,
        reverses: candidate.reverses === true,
      },
      ownedRoot,
      { label: candidate.label, depth: 1, seen: new Set() }
    );
    roots.set(ownedRoot, [
      ...(roots.get(ownedRoot) ?? []),
      { candidate, root },
    ]);
  }
  return { owners, roots };
}

type OwnerExpansion = Omit<
  ProjectionVisit,
  "authority" | "canVisit" | "reverses" | "target"
> & {
  readonly target: ts.Type;
  entries: readonly CandidateRoot[];
  search: { count: number; complete: boolean };
};

function expandOwnerRoot(expansion: OwnerExpansion) {
  const { checker, owners, root, entries, search, target } = expansion;
  let found = false;
  for (const { candidate, root: sourceRoot } of entries) {
    const visited = new Map<ts.Type, number>();
    if (
      visitOwnerProjection(
        {
          checker,
          owners,
          authority: candidate.authority,
          root: sourceRoot,
          reverses: candidate.reverses === true,
          target,
          canVisit(type, depth) {
            if (!search.complete) {
              return false;
            }
            const previousDepth = visited.get(type);
            if (previousDepth !== undefined && previousDepth >= depth) {
              return false;
            }
            visited.set(type, depth);
            search.count += 1;
            if (search.count > 4096) {
              search.complete = false;
              return false;
            }
            return true;
          },
        },
        root,
        { label: candidate.label, depth: maxOwnerDepth, seen: new Set() }
      )
    ) {
      found = true;
    }
  }
  return found;
}

function foreignRuntimeType(
  type: ts.Type,
  localPackageRoot: string | undefined,
  hasLocalOwner: boolean,
  localTypes: Map<ts.Type, boolean>
): boolean {
  if (localPackageRoot === undefined || hasLocalOwner) {
    return false;
  }
  let local = localTypes.get(type);
  if (local === undefined) {
    local = declaredInPackage(type, localPackageRoot);
    localTypes.set(type, local);
  }
  return local || declaredInDefaultLibrary(type);
}

export function ownerProjections(
  checker: ts.TypeChecker,
  candidates: readonly OwnerCandidate[],
  localPackageRoot?: string
): OwnerProjectionIndex {
  const { owners, roots } = rootOwners(checker, candidates);
  const resolved = new Map<ts.Type, OwnerProjection | null>();
  const unresolved = new Set<ts.Type>();
  const localTypes = new Map<ts.Type, boolean>();
  const fieldIndexes = new Map<ts.Type, OwnerFieldIndex>();
  const hasLocalOwner =
    localPackageRoot !== undefined &&
    candidates.some(
      (candidate) =>
        candidate.authorityState === "accepted" &&
        declaredInPackage(candidate.type, localPackageRoot)
    );
  const directOwner = directOwnerReader(owners);
  return {
    unresolved,
    get size() {
      return owners.size;
    },
    getDirect: directOwner,
    get(type) {
      const direct = directOwner(type);
      if (direct) {
        unresolved.delete(type);
        return direct;
      }
      if (!objectType(type)) {
        return undefined;
      }
      if (resolved.has(type)) {
        return resolved.get(type) ?? undefined;
      }
      if (
        foreignRuntimeType(type, localPackageRoot, hasLocalOwner, localTypes)
      ) {
        resolved.set(type, null);
        return undefined;
      }
      const search = { count: 0, complete: true };
      const pending = pendingOwnerRoots(checker, roots, type, fieldIndexes);
      for (const { root, entries } of pending) {
        expandOwnerRoot({
          checker,
          owners,
          root,
          entries,
          search,
          target: type,
        });
        const match = directOwner(type);
        if (match) {
          unresolved.delete(type);
          resolved.set(type, match);
          return match;
        }
        if (!search.complete) {
          break;
        }
      }
      if (!search.complete) {
        unresolved.add(type);
      }
      resolved.set(type, null);
      return undefined;
    },
  };
}

export function contextualOwner(
  checker: ts.TypeChecker,
  owners: OwnerProjectionIndex,
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

const ownerTypeSets = new WeakMap<OwnerProjection, ReadonlySet<ts.Type>>();

function ownerTypes(checker: ts.TypeChecker, owner: OwnerProjection) {
  const cached = ownerTypeSets.get(owner);
  if (cached) {
    return cached;
  }
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
  ownerTypeSets.set(owner, visited);
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
