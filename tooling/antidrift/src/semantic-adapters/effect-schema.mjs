import ts from "typescript";

// Effect Schema decoders are curried: Schema.decodeUnknownSync(S) returns the
// decoder, and the value arrives on the second call. `decode*` variants accept
// values already typed as the schema input; `decodeUnknown*` accept unknown.
export const EFFECT_DECODE_METHODS = new Set([
  "decode",
  "decodeSync",
  "decodePromise",
  "decodeOption",
  "decodeEither",
  "decodeUnknown",
  "decodeUnknownSync",
  "decodeUnknownPromise",
  "decodeUnknownOption",
  "decodeUnknownEither",
  "decodeUnknownEffect",
  "decodeUnknownExit",
]);

export function isEffectSchemaMethod(checker, tsNameNode) {
  const sym = tsNameNode && checker.getSymbolAtLocation(tsNameNode);
  const resolved =
    sym && sym.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(sym)
      : sym;
  for (const decl of resolved?.declarations ?? []) {
    const file = decl.getSourceFile().fileName.replace(/\\/gu, "/");
    const idx = file.lastIndexOf("/node_modules/");
    if (idx === -1) continue;
    const rest = file.slice(idx + "/node_modules/".length);
    if (
      rest === "effect" ||
      rest.startsWith("effect/") ||
      rest.startsWith("@effect/schema")
    ) {
      return true;
    }
  }
  return false;
}

// `Schema.decodeUnknownSync(S)(value)` — outer call carries the value, inner
// call carries the schema. Returns { schemaArg, valueArg } or null.
export function effectDecodeCallParts(node, services, checker) {
  if (node?.type !== "CallExpression" || node.arguments.length === 0) {
    return null;
  }
  const inner = node.callee;
  if (inner?.type !== "CallExpression" || inner.arguments.length === 0) {
    return null;
  }
  const decoder = inner.callee;
  if (
    decoder?.type !== "MemberExpression" ||
    decoder.computed ||
    decoder.property?.type !== "Identifier" ||
    !EFFECT_DECODE_METHODS.has(decoder.property.name)
  ) {
    return null;
  }
  const tsInner = services.esTreeNodeToTSNodeMap.get(inner);
  if (
    !tsInner ||
    !ts.isCallExpression(tsInner) ||
    !ts.isPropertyAccessExpression(tsInner.expression) ||
    !isEffectSchemaMethod(checker, tsInner.expression.name)
  ) {
    return null;
  }
  return {
    method: decoder.property.name,
    schemaArg: inner.arguments[0],
    valueArg: node.arguments[0],
  };
}

// Whether an already-built decoder value is applied: `const dec = Schema.decodeUnknownSync(S); dec(value)`
// is out of scope for now — only direct curried application is recognized.
export function isEffectDecodeApplication(node, services, checker) {
  return Boolean(effectDecodeCallParts(node, services, checker));
}
