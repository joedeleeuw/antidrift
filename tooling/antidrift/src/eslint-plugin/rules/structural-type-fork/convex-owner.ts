import ts from "typescript";

import { resolveAliasedSymbol } from "../../../semantic-adapters/provenance/symbol-provenance.ts";

function declaresInConvexOwnedModule(symbol: ts.Symbol | null | undefined) {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    const fileName = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    if (
      fileName.includes("/convex/_generated/") ||
      fileName.includes("/node_modules/convex/")
    ) {
      return true;
    }
  }
  return false;
}

export function isConvexOwnerReferenceAlias(
  checker: ts.TypeChecker,
  node: ts.Node
): boolean {
  if (!ts.isTypeAliasDeclaration(node) || !ts.isTypeReferenceNode(node.type)) {
    return false;
  }
  const resolved = resolveAliasedSymbol(
    checker,
    checker.getSymbolAtLocation(node.type.typeName)
  );
  return declaresInConvexOwnedModule(resolved);
}
