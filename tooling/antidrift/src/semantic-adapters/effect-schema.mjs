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
  const isCurried = node.callee?.type === "CallExpression";
  const schemaCall = isCurried ? node.callee : node;
  const valueArg = isCurried ? node.arguments[0] : node.arguments[1];
  if (!valueArg || schemaCall.arguments.length === 0) {
    return null;
  }
  const decoder = schemaCall.callee;
  if (
    decoder?.type !== "MemberExpression" ||
    decoder.computed ||
    decoder.property?.type !== "Identifier" ||
    !EFFECT_DECODE_METHODS.has(decoder.property.name)
  ) {
    return null;
  }
  const tsSchemaCall = services.esTreeNodeToTSNodeMap.get(schemaCall);
  if (
    !tsSchemaCall ||
    !ts.isCallExpression(tsSchemaCall) ||
    !ts.isPropertyAccessExpression(tsSchemaCall.expression) ||
    !isEffectSchemaMethod(checker, tsSchemaCall.expression.name)
  ) {
    return null;
  }
  return {
    method: decoder.property.name,
    schemaArg: schemaCall.arguments[0],
    tsSchemaArg: tsSchemaCall.arguments[0],
    valueArg,
  };
}

// Whether an already-built decoder value is applied: `const dec = Schema.decodeUnknownSync(S); dec(value)`
// is out of scope for now — only direct curried application is recognized.
export function isEffectDecodeApplication(node, services, checker) {
  return Boolean(effectDecodeCallParts(node, services, checker));
}
