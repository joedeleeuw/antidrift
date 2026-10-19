import ts from "typescript";
import type { ReferenceChain } from "./narrowing-syntax.ts";
import {
  chainOccurrence,
  collectThisOccurrences,
  thisContainer,
} from "./narrowing-syntax.ts";

type ReferenceOccurrence = ReturnType<typeof chainOccurrence>[number];

const referenceIndexByChecker = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>
>();

function referenceIndex(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): Map<ts.Symbol, ts.Expression[]> {
  let indexBySourceFile:
    | WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>
    | undefined = referenceIndexByChecker.get(checker);
  if (!indexBySourceFile) {
    indexBySourceFile = new WeakMap();
    referenceIndexByChecker.set(checker, indexBySourceFile);
  }
  const cached = indexBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const occurrencesBySymbol = new Map<ts.Symbol, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        const occurrences = occurrencesBySymbol.get(symbol) ?? [];
        occurrences.push(node);
        occurrencesBySymbol.set(symbol, occurrences);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  indexBySourceFile.set(sourceFile, occurrencesBySymbol);
  return occurrencesBySymbol;
}

export function rootOccurrences(
  checker: ts.TypeChecker,
  chain: ReferenceChain
): readonly ts.Expression[] {
  if (chain.root.kind === ts.SyntaxKind.ThisKeyword) {
    return collectThisOccurrences(thisContainer(chain.root));
  }
  const symbol = checker.getSymbolAtLocation(chain.root);
  if (!symbol) {
    return [];
  }
  return referenceIndex(checker, chain.root.getSourceFile()).get(symbol) ?? [];
}

export function referenceOccurrences(
  checker: ts.TypeChecker,
  chain: ReferenceChain
): ReferenceOccurrence[] {
  return rootOccurrences(checker, chain).flatMap((rootOccurrence) =>
    chainOccurrence(rootOccurrence, chain.memberNames)
  );
}
