import ts from "typescript";

function moduleSpecifiers(sourceFile: ts.SourceFile) {
  return sourceFile.statements.flatMap((statement: ts.Statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [statement.moduleSpecifier.text];
    }
    return [];
  });
}

function buildModuleGraph(program: ts.Program) {
  const imports = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const candidate of program.getSourceFiles()) {
    if (
      candidate.isDeclarationFile ||
      candidate.fileName.includes("/node_modules/")
    ) {
      continue;
    }
    for (const specifier of moduleSpecifiers(candidate)) {
      const resolved = ts.resolveModuleName(
        specifier,
        candidate.fileName,
        program.getCompilerOptions(),
        ts.sys,
        undefined,
        undefined,
        candidate.impliedNodeFormat
      ).resolvedModule;
      if (!resolved) {
        continue;
      }
      const imported = program.getSourceFile(resolved.resolvedFileName);
      if (!imported || imported.isDeclarationFile) {
        continue;
      }
      imports.set(candidate.fileName, [
        ...(imports.get(candidate.fileName) ?? []),
        resolved.resolvedFileName,
      ]);
      dependents.set(resolved.resolvedFileName, [
        ...(dependents.get(resolved.resolvedFileName) ?? []),
        candidate.fileName,
      ]);
    }
  }
  return { imports, dependents };
}

const moduleGraphs = new WeakMap<
  ts.Program,
  ReturnType<typeof buildModuleGraph>
>();

export function relevantFilePaths(
  program: ts.Program,
  sourceFile: ts.SourceFile
) {
  const graph = moduleGraphs.get(program) ?? buildModuleGraph(program);
  moduleGraphs.set(program, graph);
  return [
    ...new Set([
      sourceFile.fileName,
      ...(graph.imports.get(sourceFile.fileName) ?? []),
      ...(graph.dependents.get(sourceFile.fileName) ?? []),
    ]),
  ];
}

export function scopedSpecifiers(
  program: ts.Program,
  filePaths: readonly string[]
) {
  return new Set(
    filePaths.flatMap((filePath) => {
      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) {
        throw new TypeError(
          `${filePath} is absent from the ownership program.`
        );
      }
      return moduleSpecifiers(sourceFile);
    })
  );
}
