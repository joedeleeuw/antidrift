import { isTestFile } from "./scope.js";

export function addSetEntry(map, key, entry) {
  if (!key) return;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Set();
    map.set(key, bucket);
  }
  bucket.add(entry);
}

export function resolveSymbolKey(checker, tsNode) {
  if (!checker || !tsNode) return null;
  let sym = checker.getSymbolAtLocation?.(tsNode);
  if (!sym) return null;
  if ((sym.flags & 2_097_152) !== 0 && checker.getAliasedSymbol) {
    const aliased = checker.getAliasedSymbol(sym);
    if (aliased && aliased.name !== "unknown") sym = aliased;
  }
  const decl = sym.declarations?.[0];
  const declFile = decl?.getSourceFile?.()?.fileName?.replaceAll("\\", "/");
  const ownerPrefix =
    typeof decl?.parent?.name?.text === "string"
      ? `${decl.parent.name.text}.`
      : "";
  return declFile && typeof sym.name === "string"
    ? `${declFile}:${ownerPrefix}${sym.name}`
    : null;
}

function heritageTargetName(heritageType) {
  const expr = heritageType?.expression;
  return typeof expr?.text === "string"
    ? expr.text
    : (expr?.name?.text ?? null);
}

function unwrappedTypeNameNode(typeNode) {
  if (!typeNode) return null;
  if (
    typeNode.typeName?.text === "Promise" &&
    Array.isArray(typeNode.typeArguments) &&
    typeNode.typeArguments.length === 1
  ) {
    return typeNode.typeArguments[0]?.typeName ?? null;
  }
  return typeNode.typeName ?? null;
}

function isSeamImplementationNode(tsNode) {
  if (Array.isArray(tsNode.initializer?.properties)) return true;
  return (
    !tsNode.parameters &&
    !tsNode.name &&
    Array.isArray(tsNode.expression?.properties)
  );
}

export function recordImplementedSeams(tsNode, checker, snapshot) {
  if (isTestFile(snapshot.fileName)) return;
  const label =
    typeof tsNode.name?.text === "string"
      ? tsNode.name.text
      : String(tsNode.pos ?? 0);
  const implId = `${snapshot.fileName}:${label}`;
  if (Array.isArray(tsNode.heritageClauses)) {
    for (const clause of tsNode.heritageClauses) {
      for (const heritageType of clause.types ?? []) {
        addSetEntry(
          snapshot.implementedSeams,
          heritageTargetName(heritageType),
          implId
        );
        addSetEntry(
          snapshot.implementedSeams,
          resolveSymbolKey(checker, heritageType?.expression),
          implId
        );
      }
    }
  }
  const typeName = isSeamImplementationNode(tsNode)
    ? unwrappedTypeNameNode(tsNode.type)
    : null;
  const typeRefName =
    typeof typeName?.text === "string"
      ? typeName.text
      : (typeName?.right?.text ?? null);
  if (typeRefName) {
    addSetEntry(snapshot.implementedSeams, typeRefName, implId);
    addSetEntry(
      snapshot.implementedSeams,
      resolveSymbolKey(checker, typeName),
      implId
    );
  }
}
