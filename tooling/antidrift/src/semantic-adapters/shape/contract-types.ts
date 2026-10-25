import ts from "typescript";

const maxDepth = 8;

const OPAQUE_TYPE_FLAGS =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;

export function objectType(type: ts.Type | null | undefined): boolean {
  if (!type) {
    return false;
  }
  return type.isUnion()
    ? type.types.every((part) => objectType(part))
    : (type.flags & ts.TypeFlags.Object) !== 0;
}

export function dataProperty(property: ts.Symbol | null | undefined): boolean {
  return (
    property !== null &&
    property !== undefined &&
    !(property.declarations ?? []).some(
      (node) =>
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    )
  );
}

function propertyModifiers(property: ts.Symbol) {
  const declarations = property.declarations ?? [];
  return {
    optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
    readonly: declarations.some((node) =>
      (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
      )
    ),
    method: declarations.some(
      (node) => ts.isMethodSignature(node) || ts.isMethodDeclaration(node)
    ),
  };
}

function hasOpaqueSurface(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0 ||
    checker.getIndexInfosOfType(type).length > 0
  );
}

type BoundedVisit = {
  readonly type: ts.Type;
  readonly depth: number;
};

const boundedTypeCache = new WeakMap<
  ts.TypeChecker,
  Map<ts.Type, { depth: number; result: boolean }>
>();

function expandBoundedType(
  checker: ts.TypeChecker,
  current: BoundedVisit,
  pending: BoundedVisit[],
  work: number
): number | "invalid" | "exhausted" {
  if (current.depth === 0) {
    return "invalid";
  }
  if (current.type.isUnionOrIntersection()) {
    for (const part of current.type.types) {
      if (work >= 4096) {
        return "exhausted";
      }
      pending.push({ type: part, depth: current.depth - 1 });
      work += 1;
    }
    return work;
  }
  if ((current.type.flags & OPAQUE_TYPE_FLAGS) !== 0) {
    return "invalid";
  }
  if (!objectType(current.type)) {
    return work;
  }
  if (hasOpaqueSurface(checker, current.type)) {
    return "invalid";
  }
  for (const property of checker.getPropertiesOfType(current.type)) {
    if (!dataProperty(property)) {
      return "invalid";
    }
    if (work >= 4096) {
      return "exhausted";
    }
    pending.push({
      type: checker.getTypeOfSymbol(property),
      depth: current.depth - 1,
    });
    work += 1;
  }
  return work;
}

function cacheBoundedResult(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  bounded: boolean
): boolean {
  const cache =
    boundedTypeCache.get(checker) ??
    new Map<ts.Type, { depth: number; result: boolean }>();
  boundedTypeCache.set(checker, cache);
  cache.set(type, { depth, result: bounded });
  return bounded;
}

export function boundedType(
  checker: ts.TypeChecker,
  type: ts.Type | null | undefined,
  depth = maxDepth
): boolean {
  if (!type) {
    return false;
  }
  const cached = boundedTypeCache.get(checker)?.get(type);
  if (cached && cached.depth >= depth) {
    return cached.result;
  }
  const pending: BoundedVisit[] = [{ type, depth }];
  const visited = new Map<ts.Type, number>();
  let work = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) {
      break;
    }
    const previousDepth = visited.get(current.type);
    if (previousDepth !== undefined && previousDepth >= current.depth) {
      continue;
    }
    visited.set(current.type, current.depth);
    const expandedWork = expandBoundedType(checker, current, pending, work);
    if (expandedWork === "invalid" || expandedWork === "exhausted") {
      return cacheBoundedResult(checker, type, depth, false);
    }
    work = expandedWork;
  }
  return cacheBoundedResult(checker, type, depth, true);
}

export function sameModifiers(left: ts.Symbol, right: ts.Symbol): boolean {
  return (
    JSON.stringify(propertyModifiers(left)) ===
    JSON.stringify(propertyModifiers(right))
  );
}
