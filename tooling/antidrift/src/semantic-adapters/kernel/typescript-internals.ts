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
  function isNamedDeclaration(
    node: ts.Node
  ): node is ts.NamedDeclaration & { readonly name: ts.DeclarationName };
  interface SourceFile {
    readonly redirectInfo?: { readonly unredirected: ts.SourceFile };
    readonly scriptKind: ts.ScriptKind;
  }
  interface Node {
    readonly symbol?: ts.Symbol;
    readonly localSymbol?: ts.Symbol;
  }
  interface Type {
    readonly intrinsicName?: string;
    readonly objectFlags?: ts.ObjectFlags;
    readonly isThisType?: boolean;
    readonly target?: ts.Type;
    readonly templateType?: ts.Type;
    readonly constraintType?: ts.Type;
    readonly objectType?: ts.Type;
    readonly indexType?: ts.Type;
  }
  interface GenericType {
    readonly readonly?: boolean;
    readonly elementFlags?: readonly ts.ElementFlags[];
  }
  interface Program {
    getCommonSourceDirectory(): string;
  }
  interface TypeChecker {
    getTypeArguments(type: ts.Type): readonly ts.Type[];
    getPromisedTypeOfPromise(type: ts.Type): ts.Type | undefined;
    getSignatureFromDeclaration(
      declaration: ts.SignatureDeclaration | ts.JSDocSignature
    ): ts.Signature | undefined;
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

export const primitiveTypeFlags =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.VoidLike |
  ts.TypeFlags.Null;

export function isErrorType(type: ts.Type): boolean {
  return type.intrinsicName === "error";
}

function isTemplateLiteralType(type: ts.Type): type is ts.TemplateLiteralType {
  return (type.flags & ts.TypeFlags.TemplateLiteral) !== 0;
}

export function memberTypes(type: ts.Type): readonly ts.Type[] {
  if (type.isUnionOrIntersection() || isTemplateLiteralType(type)) {
    return type.types;
  }
  return [];
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
