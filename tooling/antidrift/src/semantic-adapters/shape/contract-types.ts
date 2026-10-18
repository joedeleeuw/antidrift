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

export function boundedType(
  checker: ts.TypeChecker,
  type: ts.Type | null | undefined,
  depth = maxDepth,
  seen = new Set<ts.Type>()
): boolean {
  if (!type || (type.flags & OPAQUE_TYPE_FLAGS) !== 0) {
    return false;
  }
  if (seen.has(type)) {
    return true;
  }
  if (depth === 0) {
    return false;
  }
  const next = new Set([...seen, type]);
  if (type.isUnionOrIntersection()) {
    return type.types.every((part) =>
      boundedType(checker, part, depth - 1, next)
    );
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return true;
  }
  if (hasOpaqueSurface(checker, type)) {
    return false;
  }
  return checker
    .getPropertiesOfType(type)
    .every(
      (property) =>
        dataProperty(property) &&
        boundedType(checker, checker.getTypeOfSymbol(property), depth - 1, next)
    );
}

export function sameModifiers(left: ts.Symbol, right: ts.Symbol): boolean {
  return (
    JSON.stringify(propertyModifiers(left)) ===
    JSON.stringify(propertyModifiers(right))
  );
}

function equivalentMembers(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
  depth: number,
  seen: Map<ts.Type, ts.Type>
): boolean {
  const leftParts = left.isUnion() ? left.types : [left];
  const rightParts = right.isUnion() ? right.types : [right];
  if (left.isUnion() || right.isUnion()) {
    return (
      leftParts.length === rightParts.length &&
      leftParts.every((part) =>
        rightParts.some((other) =>
          equivalentType(checker, part, other, depth, seen)
        )
      )
    );
  }
  if (!objectType(left) || !objectType(right)) {
    return true;
  }
  const properties = checker.getPropertiesOfType(left);
  return (
    properties.length === checker.getPropertiesOfType(right).length &&
    properties.every((property) => {
      const other = checker.getPropertyOfType(right, property.name);
      return (
        other !== undefined &&
        sameModifiers(property, other) &&
        equivalentType(
          checker,
          checker.getTypeOfSymbol(property),
          checker.getTypeOfSymbol(other),
          depth,
          seen
        )
      );
    })
  );
}

export function equivalentType(
  checker: ts.TypeChecker,
  left: ts.Type | null | undefined,
  right: ts.Type | null | undefined,
  depth = maxDepth,
  seen = new Map<ts.Type, ts.Type>()
): boolean {
  if (!left || !right) {
    return false;
  }
  if (((left.flags | right.flags) & OPAQUE_TYPE_FLAGS) !== 0) {
    return left === right;
  }
  if (
    !checker.isTypeAssignableTo(left, right) ||
    !checker.isTypeAssignableTo(right, left)
  ) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.isIntersection() || right.isIntersection()) {
    return false;
  }
  if (
    [left, right].some(
      (type) =>
        hasOpaqueSurface(checker, type) ||
        checker
          .getPropertiesOfType(type)
          .some((property) => !dataProperty(property))
    )
  ) {
    return false;
  }
  if (seen.get(left) === right) {
    return true;
  }
  if (depth === 0) {
    return false;
  }
  return equivalentMembers(
    checker,
    left,
    right,
    depth - 1,
    new Map([...seen, [left, right]])
  );
}
