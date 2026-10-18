import ts from "typescript";

const BROAD_FLAGS = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

export function broad(type: ts.Type | null | undefined): boolean {
  return Boolean(type && (type.flags & BROAD_FLAGS) !== 0);
}

export function shapeless(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.NonPrimitive) {
    return true;
  }
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    !type.getProperties().length &&
    !type.getCallSignatures().length &&
    !type.getConstructSignatures().length &&
    !type.getStringIndexType() &&
    !type.getNumberIndexType()
  );
}

export function typed(
  type: ts.Type | null | undefined,
  options: { readonly allowTypeParameter?: boolean } = {}
): boolean {
  if (!type) {
    return false;
  }
  const disallowed =
    BROAD_FLAGS |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never |
    (options.allowTypeParameter ? 0 : ts.TypeFlags.TypeParameter);
  return !(type.flags & disallowed) && !shapeless(type);
}
