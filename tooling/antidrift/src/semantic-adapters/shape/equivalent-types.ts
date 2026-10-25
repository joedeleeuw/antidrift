import ts from "typescript";

import { dataProperty, objectType, sameModifiers } from "./contract-types.ts";

const maxDepth = 8;
const OPAQUE_TYPE_FLAGS =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
const NO_DEPENDENCIES: DependencyMap = new Map();

type DependencyMap = ReadonlyMap<ts.Type, ReadonlySet<ts.Type>>;
type TypeEquivalence = {
  readonly matches: boolean;
  readonly dependencies: DependencyMap;
};
type CachedEquivalence = {
  readonly depth: number;
  readonly matches: boolean;
};
type PendingEquivalence = {
  readonly depth: number;
  readonly dependencies: DependencyMap;
};
type PendingComparisons = Map<ts.Type, Map<ts.Type, PendingEquivalence>>;

const equivalenceCache = new WeakMap<
  ts.TypeChecker,
  Map<ts.Type, Map<ts.Type, CachedEquivalence>>
>();

function withDependency(
  dependencies: DependencyMap,
  left: ts.Type,
  right: ts.Type
): DependencyMap {
  const next = new Map(dependencies);
  next.set(left, new Set([...(next.get(left) ?? []), right]));
  return next;
}

function mergeDependencies(
  left: DependencyMap,
  right: DependencyMap
): DependencyMap {
  if (left.size === 0) {
    return right;
  }
  if (right.size === 0) {
    return left;
  }
  const merged = new Map(left);
  for (const [type, dependencies] of right) {
    merged.set(type, new Set([...(merged.get(type) ?? []), ...dependencies]));
  }
  return merged;
}

function withoutDependency(
  dependencies: DependencyMap,
  left: ts.Type,
  right: ts.Type
): DependencyMap {
  if (!dependencies.get(left)?.has(right)) {
    return dependencies;
  }
  const remaining = new Map(dependencies);
  const rightTypes = new Set(remaining.get(left));
  rightTypes.delete(right);
  if (rightTypes.size === 0) {
    remaining.delete(left);
  } else {
    remaining.set(left, rightTypes);
  }
  return remaining;
}

function dependenciesActive(
  dependencies: DependencyMap,
  seen: ReadonlyMap<ts.Type, ts.Type>
): boolean {
  return [...dependencies].every(([left, rightTypes]) =>
    [...rightTypes].every((right) => seen.get(left) === right)
  );
}

function cachedEquivalence(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number
): TypeEquivalence | undefined {
  const cached = equivalenceCache.get(checker)?.get(left)?.get(right);
  return cached && cached.depth >= depth
    ? { matches: cached.matches, dependencies: NO_DEPENDENCIES }
    : undefined;
}

function rememberValidated(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number,
  matches: boolean
) {
  const comparisons =
    equivalenceCache.get(checker) ??
    new Map<ts.Type, Map<ts.Type, CachedEquivalence>>();
  equivalenceCache.set(checker, comparisons);
  const rightComparisons =
    comparisons.get(left) ?? new Map<ts.Type, CachedEquivalence>();
  const previous = rightComparisons.get(right);
  if (!previous || previous.depth < depth) {
    rightComparisons.set(right, { depth, matches });
    comparisons.set(left, rightComparisons);
  }
}

function pendingEquivalence(
  left: ts.Type,
  right: ts.Type,
  depth: number,
  seen: ReadonlyMap<ts.Type, ts.Type>,
  pending: PendingComparisons
): TypeEquivalence | undefined {
  const cached = pending.get(left)?.get(right);
  return cached &&
    cached.depth >= depth &&
    dependenciesActive(cached.dependencies, seen)
    ? { matches: true, dependencies: cached.dependencies }
    : undefined;
}

type ComparisonContext = {
  readonly checker: ts.TypeChecker;
  readonly pending: PendingComparisons;
};

function rememberEquivalence(
  left: ts.Type,
  right: ts.Type,
  depth: number,
  equivalence: TypeEquivalence,
  context: ComparisonContext
): TypeEquivalence {
  const { checker, pending } = context;
  const rightComparisons = pending.get(left) ?? new Map();
  rightComparisons.delete(right);
  if (equivalence.matches && equivalence.dependencies.size > 0) {
    rightComparisons.set(right, {
      depth,
      dependencies: equivalence.dependencies,
    });
    pending.set(left, rightComparisons);
  } else {
    rememberValidated(checker, left, right, depth, equivalence.matches);
  }
  return equivalence;
}

function equivalentUnion(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number,
  seen: Map<ts.Type, ts.Type>,
  pending: PendingComparisons
): TypeEquivalence {
  const leftParts = left.isUnion() ? left.types : [left];
  const rightParts = right.isUnion() ? right.types : [right];
  if (leftParts.length !== rightParts.length) {
    return { matches: false, dependencies: NO_DEPENDENCIES };
  }
  let dependencies: DependencyMap = NO_DEPENDENCIES;
  for (const part of leftParts) {
    let matched = false;
    for (const other of rightParts) {
      const comparison = compareTypes(
        checker,
        part,
        other,
        depth,
        seen,
        pending
      );
      dependencies = mergeDependencies(dependencies, comparison.dependencies);
      if (comparison.matches) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { matches: false, dependencies };
    }
  }
  return { matches: true, dependencies };
}

function equivalentMembers(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number,
  seen: Map<ts.Type, ts.Type>,
  pending: PendingComparisons
): TypeEquivalence {
  if (left.isUnion() || right.isUnion()) {
    return equivalentUnion(checker, left, right, depth, seen, pending);
  }
  if (!objectType(left) || !objectType(right)) {
    return { matches: true, dependencies: NO_DEPENDENCIES };
  }
  const properties = checker.getPropertiesOfType(left);
  if (properties.length !== checker.getPropertiesOfType(right).length) {
    return { matches: false, dependencies: NO_DEPENDENCIES };
  }
  let dependencies: DependencyMap = NO_DEPENDENCIES;
  for (const property of properties) {
    const other = checker.getPropertyOfType(right, property.name);
    if (!other || !sameModifiers(property, other)) {
      return { matches: false, dependencies };
    }
    const comparison = compareTypes(
      checker,
      checker.getTypeOfSymbol(property),
      checker.getTypeOfSymbol(other),
      depth,
      seen,
      pending
    );
    dependencies = mergeDependencies(dependencies, comparison.dependencies);
    if (!comparison.matches) {
      return { matches: false, dependencies };
    }
  }
  return { matches: true, dependencies };
}

function incomparableTypes(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number
): boolean {
  return (
    ((left.flags | right.flags) & OPAQUE_TYPE_FLAGS) !== 0 ||
    !checker.isTypeAssignableTo(left, right) ||
    !checker.isTypeAssignableTo(right, left) ||
    left.isIntersection() ||
    right.isIntersection() ||
    depth === 0
  );
}

function opaqueTypeSurface(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0 ||
    checker.getIndexInfosOfType(type).length > 0 ||
    checker
      .getPropertiesOfType(type)
      .some((property) => !dataProperty(property))
  );
}

function compareTypes(
  checker: ts.TypeChecker,
  left: ts.Type | null | undefined,
  right: ts.Type | null | undefined,
  depth: number,
  seen: Map<ts.Type, ts.Type>,
  pending: PendingComparisons
): TypeEquivalence {
  if (!left || !right) {
    return { matches: false, dependencies: NO_DEPENDENCIES };
  }
  if (left === right) {
    return { matches: true, dependencies: NO_DEPENDENCIES };
  }
  const cached = cachedEquivalence(checker, left, right, depth);
  if (cached) {
    return cached;
  }
  if (seen.get(left) === right) {
    return {
      matches: true,
      dependencies: withDependency(NO_DEPENDENCIES, left, right),
    };
  }
  const pendingMatch = pendingEquivalence(left, right, depth, seen, pending);
  if (pendingMatch) {
    return pendingMatch;
  }
  if (
    incomparableTypes(checker, left, right, depth) ||
    [left, right].some((type) => opaqueTypeSurface(checker, type))
  ) {
    return rememberEquivalence(
      left,
      right,
      depth,
      { matches: false, dependencies: NO_DEPENDENCIES },
      { checker, pending }
    );
  }
  const equivalence = equivalentMembers(
    checker,
    left,
    right,
    depth - 1,
    new Map([...seen, [left, right]]),
    pending
  );
  return rememberEquivalence(
    left,
    right,
    depth,
    {
      matches: equivalence.matches,
      dependencies: withoutDependency(equivalence.dependencies, left, right),
    },
    { checker, pending }
  );
}

function dependenciesValidated(
  checker: ts.TypeChecker,
  dependencies: DependencyMap,
  depth: number
): boolean {
  return [...dependencies].every(([left, rightTypes]) =>
    [...rightTypes].every(
      (right) =>
        cachedEquivalence(checker, left, right, depth)?.matches === true
    )
  );
}

function settleEquivalence(
  checker: ts.TypeChecker,
  pending: PendingComparisons,
  equivalence: TypeEquivalence
) {
  if (!equivalence.matches || equivalence.dependencies.size > 0) {
    return;
  }
  let resolved = true;
  while (resolved) {
    resolved = false;
    for (const [left, rightComparisons] of pending) {
      for (const [right, candidate] of rightComparisons) {
        if (
          dependenciesValidated(
            checker,
            candidate.dependencies,
            candidate.depth
          )
        ) {
          rememberValidated(checker, left, right, candidate.depth, true);
          rightComparisons.delete(right);
          resolved = true;
        }
      }
    }
  }
}

export function equivalentType(
  checker: ts.TypeChecker,
  left: ts.Type | null | undefined,
  right: ts.Type | null | undefined,
  depth = maxDepth,
  seen = new Map<ts.Type, ts.Type>()
): boolean {
  const pending: PendingComparisons = new Map();
  const equivalence = compareTypes(checker, left, right, depth, seen, pending);
  settleEquivalence(checker, pending, equivalence);
  return equivalence.matches;
}
