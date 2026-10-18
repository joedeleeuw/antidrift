import ts from "typescript";

import { memberTypes } from "../kernel/typescript-internals.ts";

const ANY_OR_UNKNOWN_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

export function isAppeasementCastSourceType(
  type: ts.Type | null | undefined
): boolean {
  return Boolean(type && (type.flags & ANY_OR_UNKNOWN_FLAGS) !== 0);
}

export function isBroadShapeProbeInputType(
  type: ts.Type | null | undefined,
  seen = new Set<ts.Type>()
): boolean {
  if (!type || seen.has(type)) {
    return false;
  }
  seen.add(type);
  return (
    isAppeasementCastSourceType(type) ||
    memberTypes(type).some((part) => isBroadShapeProbeInputType(part, seen))
  );
}

export function isBroadPredicateInputType(
  checker: ts.TypeChecker,
  type: ts.Type
): boolean {
  if (isAppeasementCastSourceType(type)) {
    return true;
  }
  if (
    (type.flags & ts.TypeFlags.Object) === 0 ||
    checker.getPropertiesOfType(type).length > 0
  ) {
    return false;
  }
  const indexTypes = [
    type.getStringIndexType(),
    type.getNumberIndexType(),
  ].filter((indexType) => indexType !== undefined);
  return (
    indexTypes.length === 0 || indexTypes.some(isAppeasementCastSourceType)
  );
}

export function isPredicateObjectContract(
  type: ts.Type | null | undefined
): boolean {
  if (!type || type.isUnion()) {
    return false;
  }
  if (type.isIntersection()) {
    return type.types.some((part) => isPredicateObjectContract(part));
  }
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

export function requiredTypeProps(
  checker: ts.TypeChecker,
  type: ts.Type
): Set<string> {
  const requiredNames = new Set<string>();
  for (const property of checker.getPropertiesOfType(type)) {
    if (
      (property.flags & ts.SymbolFlags.Optional) === 0 &&
      checker.getTypeOfSymbol(property).getCallSignatures().length === 0
    ) {
      requiredNames.add(property.name);
    }
  }
  return requiredNames;
}
