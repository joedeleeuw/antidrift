import ts from "typescript";

const NON_BAG_TYPE_NAMES = new Set([
  "AbortController",
  "AbortSignal",
  "Array",
  "ArrayBuffer",
  "Blob",
  "Buffer",
  "Checker",
  "CustomEvent",
  "DataView",
  "Date",
  "Document",
  "Element",
  "Error",
  "Event",
  "File",
  "FormData",
  "Function",
  "Headers",
  "HTMLElement",
  "Map",
  "Node",
  "Program",
  "Promise",
  "RangeError",
  "ReadableStream",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "ReferenceError",
  "RegExp",
  "Request",
  "Response",
  "RuleContext",
  "Set",
  "SharedArrayBuffer",
  "Signature",
  "SourceCode",
  "SourceFile",
  "Symbol",
  "SyntaxError",
  "TransformStream",
  "Type",
  "TypeChecker",
  "TypeError",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
  "Window",
  "WritableStream",
]);

const NON_BAG_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Never;

const OPEN_BAG_TYPE_FLAGS =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;

const NULLISH_TYPE_FLAGS =
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;

function nonNullishTypeParts(candidateType: ts.Type): readonly ts.Type[] {
  const parts = candidateType.isUnion() ? candidateType.types : [candidateType];
  return parts.filter((part) => (part.flags & NULLISH_TYPE_FLAGS) === 0);
}

function hasCallableSurface(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
  );
}

function isNamedNonBag(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  const symbolName = type.aliasSymbol?.name ?? symbol?.name ?? "";
  return (
    NON_BAG_TYPE_NAMES.has(symbolName) ||
    (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0)
  );
}

function isMethodLikeProperty(
  checker: ts.TypeChecker,
  property: ts.Symbol
): boolean {
  if ((property.flags & ts.SymbolFlags.Method) !== 0) {
    return true;
  }
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  if (!declaration) {
    return false;
  }
  return nonNullishTypeParts(
    checker.getTypeOfSymbolAtLocation(property, declaration)
  ).some(
    (part) =>
      checker.getSignaturesOfType(part, ts.SignatureKind.Call).length > 0
  );
}

function isPlainBagConstituentType(
  checker: ts.TypeChecker,
  constituentType: ts.Type
): boolean {
  if (
    (constituentType.flags & NON_BAG_TYPE_FLAGS) !== 0 ||
    hasCallableSurface(checker, constituentType) ||
    isNamedNonBag(constituentType)
  ) {
    return false;
  }
  const properties = checker.getPropertiesOfType(constituentType);
  if (properties.some((property) => isMethodLikeProperty(checker, property))) {
    return false;
  }
  if ((constituentType.flags & OPEN_BAG_TYPE_FLAGS) !== 0) {
    return true;
  }
  if ((constituentType.flags & ts.TypeFlags.Object) === 0) {
    return false;
  }
  return (
    properties.length > 0 ||
    checker.getIndexTypeOfType(constituentType, ts.IndexKind.String) !==
      undefined
  );
}

export function isPlainBagParameterType(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration
): boolean {
  const parts = nonNullishTypeParts(checker.getTypeAtLocation(parameter));
  return (
    parts.length > 0 &&
    parts.every((part) => isPlainBagConstituentType(checker, part))
  );
}
