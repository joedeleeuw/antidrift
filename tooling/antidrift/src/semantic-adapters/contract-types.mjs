import ts from "typescript";

const maxDepth = 8;

export function objectType(type) {
  return Boolean(
    type &&
    (type.isUnion()
      ? type.types.every(objectType)
      : type.flags & ts.TypeFlags.Object),
  );
}

export function dataProperty(property) {
  return (
    property &&
    !(property.declarations ?? []).some(
      (node) =>
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node),
    )
  );
}

export function propertyModifiers(property) {
  return {
    optional: Boolean(property.flags & ts.SymbolFlags.Optional),
    readonly: (property.declarations ?? []).some((node) =>
      (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ),
    ),
    method: (property.declarations ?? []).some(
      (node) => ts.isMethodSignature(node) || ts.isMethodDeclaration(node),
    ),
  };
}

export function boundedType(checker, type, depth = maxDepth, seen = new Set()) {
  if (
    !type ||
    type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
  ) {
    return false;
  }
  if (seen.has(type)) return true;
  if (depth === 0) return false;
  const next = new Set([...seen, type]);
  if (type.isUnionOrIntersection()) {
    return type.types.every((part) =>
      boundedType(checker, part, depth - 1, next),
    );
  }
  if (!(type.flags & ts.TypeFlags.Object)) return true;
  if (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ||
    checker.getIndexInfosOfType(type).length
  ) {
    return false;
  }
  return checker
    .getPropertiesOfType(type)
    .every(
      (property) =>
        dataProperty(property) &&
        boundedType(
          checker,
          checker.getTypeOfSymbol(property),
          depth - 1,
          next,
        ),
    );
}

export function equivalentType(
  checker,
  left,
  right,
  depth = maxDepth,
  seen = new Map(),
) {
  if (!left || !right) return false;
  // Mutual assignability through `any` is not contract equality. Identical
  // opaque types remain valid in the explicitly configured declaration policy.
  if (
    (left.flags | right.flags) &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
  ) {
    return left === right;
  }
  if (
    !checker.isTypeAssignableTo(left, right) ||
    !checker.isTypeAssignableTo(right, left)
  ) {
    return false;
  }
  if (left === right) return true;
  // Intersection normalization can erase modifiers and callable constituents.
  // A shared intersection identity is valid; fresh compositions need a richer
  // proof than mutual assignability, which deliberately ignores readonly.
  if (left.isIntersection() || right.isIntersection()) return false;
  // Properties do not fully describe callable, indexed, or accessor contracts.
  // Preserve identical owner types, but do not certify a fresh opaque surface
  // merely because TypeScript permits assignment in both directions.
  if (
    [left, right].some(
      (type) =>
        checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
        checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ||
        checker.getIndexInfosOfType(type).length ||
        checker
          .getPropertiesOfType(type)
          .some((property) => !dataProperty(property)),
    )
  ) {
    return false;
  }
  // A repeated pair closes a recursive contract only after assignability and
  // opaque-surface checks. Branch-local maps prevent union alternatives sharing
  // speculative recursion state; a different right-hand pair is checked afresh.
  if (seen.get(left) === right) return true;
  if (depth === 0) return false;
  const next = new Map([...seen, [left, right]]);
  const leftParts = left.isUnion() ? left.types : [left];
  const rightParts = right.isUnion() ? right.types : [right];
  if (left.isUnion() || right.isUnion()) {
    return (
      leftParts.length === rightParts.length &&
      leftParts.every((part) =>
        rightParts.some((other) =>
          equivalentType(checker, part, other, depth - 1, next),
        ),
      )
    );
  }
  if (!objectType(left) || !objectType(right)) return true;
  const properties = checker.getPropertiesOfType(left);
  return (
    properties.length === checker.getPropertiesOfType(right).length &&
    properties.every((property) => {
      const other = checker.getPropertyOfType(right, property.name);
      return (
        other &&
        JSON.stringify(propertyModifiers(property)) ===
          JSON.stringify(propertyModifiers(other)) &&
        equivalentType(
          checker,
          checker.getTypeOfSymbol(property),
          checker.getTypeOfSymbol(other),
          depth - 1,
          next,
        )
      );
    })
  );
}
