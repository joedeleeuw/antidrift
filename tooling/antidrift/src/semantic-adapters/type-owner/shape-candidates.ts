import ts from "typescript";

import { isSymbolPubliclyExported } from "../provenance/symbol-provenance.ts";
import { findStructuralProofs } from "../shape/structural-fork-proof.ts";
import type { LocalStructuralType } from "../shape/structural-fork-proof.ts";
import { typeProps, typePropsDetailed } from "../type-owner.mjs";
import type { CandidatesFor, OwnerScope } from "./owner-scope.ts";
import { isNamePromotionForm } from "./ownership-verdict.ts";
import { entryExportsName } from "./public-export-owners.ts";

function localDeclaration(scope: OwnerScope, local: LocalStructuralType) {
  const declaration = local.declaration ?? local.symbol.declarations?.[0];
  if (
    !declaration ||
    (!ts.isTypeAliasDeclaration(declaration) &&
      !ts.isInterfaceDeclaration(declaration))
  ) {
    throw new TypeError(
      "Structural analysis requires a named object declaration."
    );
  }
  const sourceFile = scope.program.getSourceFile(
    declaration.getSourceFile().fileName
  );
  if (!sourceFile) {
    throw new TypeError(
      `${declaration.getSourceFile().fileName} is absent from the ownership program.`
    );
  }
  let analyzed = declaration;
  if (sourceFile !== declaration.getSourceFile()) {
    const visit = (candidate: ts.Node): ts.Node | undefined => {
      if (
        candidate.kind === declaration.kind &&
        candidate.pos === declaration.pos &&
        candidate.end === declaration.end
      ) {
        return candidate;
      }
      return ts.forEachChild(candidate, visit);
    };
    const match = visit(sourceFile);
    if (
      !match ||
      (!ts.isTypeAliasDeclaration(match) && !ts.isInterfaceDeclaration(match))
    ) {
      throw new TypeError("Cannot align the structural declaration.");
    }
    analyzed = match;
  }
  const symbol = scope.checker.getSymbolAtLocation(analyzed.name);
  if (!symbol) {
    throw new TypeError(`${analyzed.name.text} has no declaration symbol.`);
  }
  const type = scope.checker.getDeclaredTypeOfSymbol(symbol);
  return {
    local: {
      ...local,
      symbol,
      type,
      props: typeProps(scope.checker, type),
      detailedProps: typePropsDetailed(scope.checker, type),
    },
    declaration: analyzed,
  };
}

function shouldExpandName(
  scope: OwnerScope,
  local: LocalStructuralType,
  declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration
) {
  if (
    !isNamePromotionForm({
      symbol: local.symbol,
      node: declaration,
      exported: isSymbolPubliclyExported(
        scope.checker,
        declaration,
        local.symbol
      ),
    })
  ) {
    return false;
  }
  const localName = local.symbol.getName();
  return scope.missingEntries.some((entry) =>
    entryExportsName(entry, localName)
  );
}

export function exactShapeCandidates(
  candidatesFor: CandidatesFor,
  query: Parameters<CandidatesFor>[0] & { local: LocalStructuralType }
) {
  const scope = candidatesFor(query);
  const { local, declaration } = localDeclaration(scope, query.local);
  const matches = findStructuralProofs(
    scope.checker,
    local,
    scope.candidates,
    "structuralTypeFork",
    scope.program
  );
  if (!shouldExpandName(scope, local, declaration)) {
    return { ...scope, matches, local, declaration };
  }
  const expanded = candidatesFor({
    ...query,
    sourceFile: declaration.getSourceFile(),
    expand: local.symbol.getName(),
  });
  const analyzed = localDeclaration(expanded, local);
  return {
    ...expanded,
    matches: [
      ...matches,
      ...findStructuralProofs(
        expanded.checker,
        analyzed.local,
        expanded.candidates,
        "structuralTypeFork",
        expanded.program
      ),
    ],
    local: analyzed.local,
    declaration: analyzed.declaration,
  };
}
