import ts from "typescript";

declare module "typescript" {
  function getCheckFlags(symbol: ts.Symbol): number;
  function getDeclarationModifierFlagsFromSymbol(
    symbol: ts.Symbol
  ): ts.ModifierFlags;
  function getFirstIdentifier(
    node: ts.EntityNameOrEntityNameExpression
  ): ts.Identifier;
  function hasType(node: ts.Node): node is ts.HasType;
  interface Type {
    readonly intrinsicName?: string;
    readonly objectFlags?: ts.ObjectFlags;
  }
  interface GenericType {
    readonly readonly?: boolean;
    readonly elementFlags?: readonly ts.ElementFlags[];
  }
  interface Signature {
    readonly minArgumentCount: number;
    readonly flags: number;
  }
}

function internalReadonlyCheckFlag(): number {
  const checkFlags: unknown = Reflect.get(ts, "CheckFlags");
  const readonlyFlag: unknown =
    typeof checkFlags === "object" && checkFlags !== null
      ? Reflect.get(checkFlags, "Readonly")
      : undefined;
  if (typeof readonlyFlag !== "number") {
    throw new TypeError(
      `typescript ${ts.version} does not expose CheckFlags.Readonly`
    );
  }
  return readonlyFlag;
}

const readonlyCheckFlag = internalReadonlyCheckFlag();

export function isErrorType(type: ts.Type): boolean {
  return type.intrinsicName === "error";
}

export function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return ((type.objectFlags ?? 0) & ts.ObjectFlags.Reference) !== 0;
}

export function isReadonlyProperty(property: ts.Symbol): boolean {
  return (
    (ts.getCheckFlags(property) & readonlyCheckFlag) !== 0 ||
    (ts.getDeclarationModifierFlagsFromSymbol(property) &
      ts.ModifierFlags.Readonly) !==
      0 ||
    ((property.flags & ts.SymbolFlags.GetAccessor) !== 0 &&
      (property.flags & ts.SymbolFlags.SetAccessor) === 0)
  );
}
