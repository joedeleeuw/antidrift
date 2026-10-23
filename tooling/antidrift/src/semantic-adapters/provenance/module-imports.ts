import ts from "typescript";

declare module "typescript" {
  interface SourceFile {
    readonly imports?: readonly ts.StringLiteralLike[];
  }
}

export type ModuleImports = {
  readonly files: ReadonlySet<ts.SourceFile>;
  readonly declarations: ReadonlySet<ts.Node>;
};

type ImportCollector = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly files: Set<ts.SourceFile>;
  readonly declarations: Set<ts.Node>;
};

const importsByProgram = new WeakMap<
  ts.Program,
  Map<ts.SourceFile, ModuleImports>
>();

function firstParty(program: ts.Program, source: ts.SourceFile): boolean {
  return (
    !program.isSourceFileFromExternalLibrary(source) &&
    !program.isSourceFileDefaultLibrary(source)
  );
}

function addSymbol(collector: ImportCollector, symbol: ts.Symbol): void {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? collector.checker.getAliasedSymbol(symbol)
      : symbol;
  for (const declaration of target.declarations ?? []) {
    const source = declaration.getSourceFile();
    if (firstParty(collector.program, source)) {
      collector.declarations.add(declaration);
      collector.files.add(source);
    }
  }
}

function addModule(
  collector: ImportCollector,
  moduleSymbol: ts.Symbol,
  wholeModule: boolean
): void {
  const sources = (moduleSymbol.declarations ?? [])
    .map((declaration) => declaration.getSourceFile())
    .filter((source) => firstParty(collector.program, source));
  for (const source of sources) {
    collector.files.add(source);
  }
  if (wholeModule && sources.length > 0) {
    for (const exported of collector.checker.getExportsOfModule(moduleSymbol)) {
      addSymbol(collector, exported);
    }
  }
}

function importedNames(
  statement: ts.Node
): readonly ts.ModuleExportName[] | "whole-module" {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      return "whole-module";
    }
    return [
      ...(clause?.name ? [clause.name] : []),
      ...(bindings?.elements.map((element) => element.name) ?? []),
    ];
  }
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (!clause || ts.isNamespaceExport(clause)) {
      return "whole-module";
    }
    return clause.elements.map((element) => element.name);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return [statement.name];
  }
  return [];
}

function collectSpecifier(
  collector: ImportCollector,
  specifier: ts.StringLiteralLike
): void {
  const moduleSymbol = collector.checker.getSymbolAtLocation(specifier);
  if (!moduleSymbol) {
    return;
  }
  const statement = ts.isExternalModuleReference(specifier.parent)
    ? specifier.parent.parent
    : specifier.parent;
  const names = importedNames(statement);
  addModule(collector, moduleSymbol, names === "whole-module");
  if (names === "whole-module") {
    return;
  }
  for (const name of names) {
    const symbol = collector.checker.getSymbolAtLocation(name);
    if (symbol) {
      addSymbol(collector, symbol);
    }
  }
}

// What one module imports or re-exports, resolved through the checker: the
// first-party files it reaches and the declarations its bindings name.
// Barrel re-exports resolve to the file that declares each imported symbol,
// and a namespace import or `export *` reaches every export of its module.
export function moduleImports(
  program: ts.Program,
  sourceFile: ts.SourceFile
): ModuleImports {
  let cache = importsByProgram.get(program);
  if (!cache) {
    cache = new Map();
    importsByProgram.set(program, cache);
  }
  const cached = cache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const collector: ImportCollector = {
    program,
    checker: program.getTypeChecker(),
    files: new Set(),
    declarations: new Set(),
  };
  for (const specifier of sourceFile.imports ?? []) {
    if (specifier.pos >= 0 && specifier.getSourceFile() === sourceFile) {
      collectSpecifier(collector, specifier);
    }
  }
  collector.files.delete(sourceFile);
  const imports = {
    files: collector.files,
    declarations: collector.declarations,
  };
  cache.set(sourceFile, imports);
  return imports;
}
