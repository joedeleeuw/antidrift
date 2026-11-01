import ts from "typescript";
import {
  gitPathsAt,
  compilerHostFor,
  affectedExportFileNames,
  exportModuleSpecifiers,
} from "./git-source-program.mjs";

const TS_SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/u;
function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareExports(left, right) {
  return (
    compareStrings(left.file, right.file) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.kind, right.kind)
  );
}

function exportKey(entry) {
  return `${entry.file}\0${entry.name}\0${entry.kind}`;
}

function aliasedSymbol(checker, symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function symbolDeclarations(symbol, resolvedSymbol) {
  return [
    ...(symbol.declarations ?? []),
    ...(resolvedSymbol.declarations ?? []),
  ];
}

function isTypeOnlyExportDeclaration(declaration) {
  if (ts.isExportSpecifier(declaration)) {
    return Boolean(
      declaration.isTypeOnly ||
      declaration.parent?.isTypeOnly ||
      declaration.parent?.parent?.isTypeOnly
    );
  }
  if (ts.isExportDeclaration(declaration)) return declaration.isTypeOnly;
  return false;
}

function isNamespaceDeclaration(declaration) {
  return (
    ts.isModuleDeclaration(declaration) ||
    declaration.kind === ts.SyntaxKind.NamespaceExport
  );
}

function exportKind(checker, symbol) {
  if (symbol.getName() === "default") return "default";
  const resolvedSymbol = aliasedSymbol(checker, symbol);
  const declarations = symbolDeclarations(symbol, resolvedSymbol);
  if (declarations.some(isNamespaceDeclaration)) return "namespace";
  if (
    symbol.flags &
    (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)
  ) {
    return "namespace";
  }
  if (
    resolvedSymbol.flags &
    (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)
  ) {
    return "namespace";
  }
  if (declarations.some(isTypeOnlyExportDeclaration)) return "type";
  const flags = symbol.flags | resolvedSymbol.flags;
  const isValue = Boolean(flags & ts.SymbolFlags.Value);
  const isType = Boolean(flags & ts.SymbolFlags.Type);
  return isType && !isValue ? "type" : "value";
}

function unresolvedModuleDiagnostics(program, sourceFile) {
  return ts
    .getPreEmitDiagnostics(program, sourceFile)
    .filter(
      (diagnostic) => diagnostic.code === 2307 || diagnostic.code === 2792
    )
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    );
}

function throwOnUnresolvedExportModules({ program, sourceFile, file }) {
  const diagnostics = unresolvedModuleDiagnostics(program, sourceFile);
  if (diagnostics.length === 0) return;
  const unresolved = exportModuleSpecifiers(sourceFile).filter((moduleName) =>
    diagnostics.some((message) => message.includes(moduleName))
  );
  if (unresolved.length === 0) return;
  throw new Error(
    `change-contract export extraction could not resolve public re-export module(s) in ${file}: ${unresolved.join(", ")}`
  );
}

function exportsForSource({ file, ref, cwd, fileNames }) {
  if (!fileNames.includes(`/${file}`)) return [];
  const options = {
    allowJs: false,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const fileName = `/${file}`;
  const program = ts.createProgram({
    rootNames: [fileName],
    options,
    host: compilerHostFor({ ref, cwd, fileNames, options }),
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return [];
  throwOnUnresolvedExportModules({ program, sourceFile, file });
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => ({
      file,
      name: symbol.getName(),
      kind: exportKind(checker, symbol),
    }))
    .sort(compareExports);
}

function changedTsPaths(changedFiles) {
  const paths = new Set();
  for (const file of changedFiles) {
    if (TS_SOURCE_RE.test(file.path)) paths.add(file.path);
    if (file.oldPath && TS_SOURCE_RE.test(file.oldPath)) {
      paths.add(file.oldPath);
    }
  }
  return [...paths].sort(compareStrings);
}

function exportsMissingFrom(entries, reference) {
  const referenceKeys = new Set(reference.map((entry) => exportKey(entry)));
  return entries.filter((entry) => !referenceKeys.has(exportKey(entry)));
}

function comparedSourcePaths(seedPaths, baseSnap, headSnap) {
  const seedFileNames = seedPaths.map((path) => `/${path}`);
  const baseAffected = affectedExportFileNames({ ...baseSnap, seedFileNames });
  const headAffected = affectedExportFileNames({ ...headSnap, seedFileNames });
  return [...new Set([...baseAffected, ...headAffected])]
    .map((fileName) => fileName.slice(1))
    .sort(compareStrings);
}

/**
 * Compare exported symbols for changed TypeScript source files at two git refs.
 * @param {{ base: string, head: string, cwd: string, changedFiles: Array<{ path: string, oldPath: string | null }> }} params
 */
export function collectExportChanges({ base, head, cwd, changedFiles }) {
  const seedPaths = changedTsPaths(changedFiles);
  if (seedPaths.length === 0) {
    return { addedExports: [], removedExports: [] };
  }
  const baseSnap = {
    ref: base,
    cwd,
    fileNames: gitPathsAt({ ref: base, cwd }).map((path) => `/${path}`),
  };
  const headSnap = {
    ref: head,
    cwd,
    fileNames: gitPathsAt({ ref: head, cwd }).map((path) => `/${path}`),
  };
  const addedExports = [];
  const removedExports = [];
  for (const file of comparedSourcePaths(seedPaths, baseSnap, headSnap)) {
    const before = exportsForSource({ file, ...baseSnap });
    const after = exportsForSource({ file, ...headSnap });
    addedExports.push(...exportsMissingFrom(after, before));
    removedExports.push(...exportsMissingFrom(before, after));
  }
  return {
    addedExports: addedExports.toSorted(compareExports),
    removedExports: removedExports.toSorted(compareExports),
  };
}
