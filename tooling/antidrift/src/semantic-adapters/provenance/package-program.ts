import { posix } from "node:path";
import ts from "typescript";
import "../kernel/typescript-internals.ts";

export function parsedSourceFile(program: ts.Program, fileName: string) {
  const sourceFile = program.getSourceFile(fileName);
  return sourceFile?.redirectInfo?.unredirected ?? sourceFile;
}
export function targetOf(checker: ts.TypeChecker, symbol: ts.Symbol) {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return checker.getExportSymbolOfSymbol(target);
}
export function exportTarget(program: ts.Program, nameNode: ts.Node) {
  const checker = program.getTypeChecker();
  return targetOf(checker, requireSymbol(checker, nameNode));
}
export function moduleExportTargets(
  program: ts.Program,
  sourceFiles: Iterable<ts.SourceFile>
) {
  const checker = program.getTypeChecker();
  const targets = new Set<ts.Symbol>();
  for (const sourceFile of sourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    for (const exported of moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol)
      : []) {
      targets.add(targetOf(checker, exported));
    }
  }
  return targets;
}
function commonDirectory(fileNames: readonly string[]) {
  let shared: string[] | null = null;
  for (const fileName of fileNames) {
    if (/\.d\.[cm]?ts$/u.test(fileName)) {
      continue;
    }
    const parts = posix.dirname(fileName).split("/");
    shared ??= parts;
    const differs = shared.findIndex(
      (segment, index) => segment !== parts[index]
    );
    if (differs >= 0) {
      shared = shared.slice(0, differs);
    }
  }
  return shared?.join("/");
}
function rootDirectoryVariants(commandLine: ts.ParsedCommandLine) {
  const variants = [commandLine];
  const computed = commonDirectory(commandLine.fileNames);
  if (!commandLine.options.rootDir && computed) {
    variants.push({
      ...commandLine,
      options: { ...commandLine.options, rootDir: computed },
    });
  }
  return variants;
}
function compilerCommandLines(configFiles: readonly string[]) {
  const commandLines: ts.ParsedCommandLine[] = [];
  for (const configFile of configFiles) {
    const loaded = ts.readConfigFile(configFile, ts.sys.readFile);
    if (loaded.error) {
      continue;
    }
    commandLines.push(
      ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        posix.dirname(configFile),
        undefined,
        configFile
      )
    );
  }
  return commandLines.flatMap(rootDirectoryVariants).map((commandLine) => ({
    commandLine,
    contains: new Set(commandLine.fileNames),
  }));
}
export function packageSources(program: ts.Program, directory: string) {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        sourceFile.fileName.startsWith(`${directory}/`)
    );
}
export function compilerOutputs(
  sources: readonly ts.SourceFile[],
  configFiles: readonly string[]
) {
  const commandLines = compilerCommandLines(configFiles);
  return sources.flatMap((sourceFile) =>
    commandLines
      .filter(({ contains }) => contains.has(sourceFile.fileName))
      .flatMap(({ commandLine }) =>
        ts.getOutputFileNames(
          commandLine,
          sourceFile.fileName,
          !ts.sys.useCaseSensitiveFileNames
        )
      )
      .map((name) => ({ name, sourceFile }))
  );
}
function requireSymbol(checker: ts.TypeChecker, node: ts.Node) {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) {
    throw new TypeError(
      `No symbol at ${node.getSourceFile().fileName}:${node.pos}`
    );
  }
  return symbol;
}
