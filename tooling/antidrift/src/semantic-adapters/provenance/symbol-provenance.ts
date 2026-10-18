import ts from "typescript";

type SymbolDependencySearch = {
  readonly checker: ts.TypeChecker;
  readonly targetSymbol: ts.Symbol | null;
  readonly sourceFile: ts.SourceFile;
  readonly seen: Set<ts.Symbol>;
};

export function resolveAliasedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | null | undefined
): ts.Symbol | null {
  if (!symbol) {
    return null;
  }
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  const aliased = checker.getAliasedSymbol(symbol);
  if (aliased.name === "unknown" && (aliased.declarations?.length ?? 0) === 0) {
    return symbol;
  }
  return aliased;
}

export function symbolAtNode(
  checker: ts.TypeChecker,
  node: ts.Node | null | undefined
): ts.Symbol | null {
  if (!node) {
    return null;
  }
  if (
    !ts.isSourceFile(node) &&
    ts.isShorthandPropertyAssignment(node.parent) &&
    node.parent.name === node
  ) {
    return resolveAliasedSymbol(
      checker,
      checker.getShorthandAssignmentValueSymbol(node.parent)
    );
  }
  return resolveAliasedSymbol(checker, checker.getSymbolAtLocation(node));
}

function localDeclarationsDependOn(
  search: SymbolDependencySearch,
  symbol: ts.Symbol
): boolean {
  const localDeclarations = (symbol.declarations ?? []).filter(
    (candidate) => candidate.getSourceFile() === search.sourceFile
  );
  if (localDeclarations.length === 0) {
    return false;
  }
  search.seen.add(symbol);
  return localDeclarations.some((candidate) =>
    declarationDependsOnSymbol(search, candidate)
  );
}

function declarationDependsOnSymbol(
  search: SymbolDependencySearch,
  currentNode: ts.Node
): boolean {
  if (ts.isIdentifier(currentNode)) {
    const symbol = symbolAtNode(search.checker, currentNode);
    if (symbol === search.targetSymbol) {
      return (
        !ts.isCallExpression(currentNode.parent) ||
        currentNode.parent.expression !== currentNode
      );
    }
    if (
      symbol &&
      !search.seen.has(symbol) &&
      localDeclarationsDependOn(search, symbol)
    ) {
      return true;
    }
  }
  return Boolean(
    ts.forEachChild(currentNode, (childNode) =>
      declarationDependsOnSymbol(search, childNode)
    )
  );
}

function isExportStatement(statement: ts.Statement): boolean {
  const modifiers = ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement)
    : undefined;
  return (
    ts.isExportAssignment(statement) ||
    ts.isExportDeclaration(statement) ||
    Boolean(
      modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
    )
  );
}

function exportedSymbolDependsOn(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  targetSymbol: ts.Symbol | null,
  sourceFile: ts.SourceFile
): boolean {
  const exportedTarget = resolveAliasedSymbol(checker, exported);
  if (exportedTarget === targetSymbol) {
    return true;
  }
  const declarations = new Set([
    ...(exported.declarations ?? []),
    ...(exportedTarget?.declarations ?? []),
  ]);
  const search = {
    checker,
    targetSymbol,
    sourceFile,
    seen: new Set(
      [exported, exportedTarget].filter((candidate) => candidate !== null)
    ),
  };
  return [...declarations].some((candidate) =>
    declarationDependsOnSymbol(search, candidate)
  );
}

export function isSymbolPubliclyExported(
  checker: ts.TypeChecker,
  declaration: ts.Node | null | undefined,
  symbol: ts.Symbol | null | undefined
): boolean {
  const sourceFile = declaration?.getSourceFile();
  if (!sourceFile || !symbol) {
    return true;
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return false;
  }
  const targetSymbol = resolveAliasedSymbol(checker, symbol);
  const exportedStatementDepends = sourceFile.statements.some(
    (statement) =>
      isExportStatement(statement) &&
      declarationDependsOnSymbol(
        { checker, targetSymbol, sourceFile, seen: new Set() },
        statement
      )
  );
  return (
    exportedStatementDepends ||
    checker
      .getExportsOfModule(moduleSymbol)
      .some((exported) =>
        exportedSymbolDependsOn(checker, exported, targetSymbol, sourceFile)
      )
  );
}

export function resolveImportedModuleSourceFile(
  checker: ts.TypeChecker,
  importDeclaration: ts.ImportDeclaration | null | undefined
): ts.SourceFile | null {
  if (
    !importDeclaration ||
    !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)
  ) {
    return null;
  }
  const moduleSymbol = checker.getSymbolAtLocation(
    importDeclaration.moduleSpecifier
  );
  const candidate =
    moduleSymbol?.valueDeclaration ?? moduleSymbol?.declarations?.[0] ?? null;
  return candidate && ts.isSourceFile(candidate) ? candidate : null;
}
