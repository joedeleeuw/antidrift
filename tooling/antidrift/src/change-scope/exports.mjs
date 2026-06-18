import { spawnSync } from "node:child_process";
import { dirname, normalize } from "node:path/posix";

import ts from "typescript";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const TS_SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/u;
const TS_PROGRAM_RE = /\.(?:ts|tsx|mts|cts)$/u;
const SOURCE_SUFFIXES = [
  ".d.mts",
  ".d.cts",
  ".d.ts",
  ".mts",
  ".cts",
  ".tsx",
  ".ts",
];
const SOURCE_EXTENSIONS = new Map([
  [".d.mts", ts.Extension.Dmts],
  [".d.cts", ts.Extension.Dcts],
  [".d.ts", ts.Extension.Dts],
  [".mts", ts.Extension.Mts],
  [".cts", ts.Extension.Cts],
  [".tsx", ts.Extension.Tsx],
  [".ts", ts.Extension.Ts],
]);
const JS_SPECIFIER_SUBSTITUTIONS = new Map([
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx", ".ts", ".d.ts"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
]);

function gitFileAt({ ref, path, cwd }) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    if (/does not exist in|but not in/iu.test(stderr)) return null;
    throw new Error(
      `git show ${ref}:${path} failed in ${cwd} (status ${result.status}): ${stderr}`,
    );
  }
  return result.stdout;
}

function gitPathsAt({ ref, cwd }) {
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", ref], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ls-tree ${ref} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .filter((path) => TS_PROGRAM_RE.test(path))
    .sort(compareStrings);
}

function isTypeScriptSourcePath(path) {
  return TS_SOURCE_RE.test(path);
}

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

function fileNameFor(path) {
  return `/${path}`;
}

function pathForFileName(fileName) {
  return fileName.slice(1);
}

function extensionForFileName(fileName) {
  for (const [suffix, extension] of SOURCE_EXTENSIONS) {
    if (fileName.endsWith(suffix)) return extension;
  }
  throw new Error(`unsupported TypeScript source extension for ${fileName}`);
}

function sourceCandidatesFor(moduleName, containingFile) {
  const base = normalize(`${dirname(containingFile)}/${moduleName}`);
  if (SOURCE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return [base];
  for (const [specifierSuffix, sourceSuffixes] of JS_SPECIFIER_SUBSTITUTIONS) {
    if (base.endsWith(specifierSuffix)) {
      const withoutSuffix = base.slice(0, -specifierSuffix.length);
      return sourceSuffixes.map(
        (sourceSuffix) => `${withoutSuffix}${sourceSuffix}`,
      );
    }
  }
  return [
    ...SOURCE_SUFFIXES.map((suffix) => `${base}${suffix}`),
    ...SOURCE_SUFFIXES.map((suffix) => `${base}/index${suffix}`),
  ];
}

function resolveRelativeSourceModule(moduleName, containingFile, fileNameSet) {
  if (!moduleName.startsWith(".")) return undefined;
  const resolvedFileName = sourceCandidatesFor(moduleName, containingFile).find(
    (candidate) => fileNameSet.has(candidate),
  );
  if (resolvedFileName === undefined) return undefined;
  return {
    resolvedFileName,
    extension: extensionForFileName(resolvedFileName),
    isExternalLibraryImport: false,
  };
}

function compilerHostFor({ ref, cwd, fileNames, options }) {
  const defaultHost = ts.createCompilerHost(options, true);
  const fileNameSet = new Set(fileNames);
  const sourceCache = new Map();
  function sourceTextFor(candidate) {
    if (!fileNameSet.has(candidate)) return undefined;
    if (!sourceCache.has(candidate)) {
      const sourceText = gitFileAt({
        ref,
        path: pathForFileName(candidate),
        cwd,
      });
      if (sourceText === null) {
        throw new Error(
          `git tree listed ${pathForFileName(candidate)} at ${ref}, but git show could not read it`,
        );
      }
      sourceCache.set(candidate, sourceText);
    }
    return sourceCache.get(candidate);
  }
  return {
    ...defaultHost,
    getCurrentDirectory() {
      return "/";
    },
    fileExists(candidate) {
      return fileNameSet.has(candidate) || defaultHost.fileExists(candidate);
    },
    readFile(candidate) {
      return sourceTextFor(candidate) ?? defaultHost.readFile(candidate);
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map(
        (moduleName) =>
          resolveRelativeSourceModule(
            moduleName,
            containingFile,
            fileNameSet,
          ) ??
          ts.resolveModuleName(moduleName, containingFile, options, defaultHost)
            .resolvedModule,
      );
    },
    getSourceFile(
      candidate,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) {
      const sourceText = sourceTextFor(candidate);
      if (sourceText !== undefined) {
        return ts.createSourceFile(
          candidate,
          sourceText,
          languageVersion,
          true,
        );
      }
      return defaultHost.getSourceFile(
        candidate,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };
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
      declaration.parent?.parent?.isTypeOnly,
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

function exportModuleSpecifiers(sourceFile) {
  const moduleNames = [];
  function visit(node) {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleNames.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return moduleNames;
}

function relativeExportTargets({ ref, cwd, fileName, fileNameSet }) {
  const sourceText = gitFileAt({ ref, path: pathForFileName(fileName), cwd });
  if (sourceText === null) return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
  );
  return exportModuleSpecifiers(sourceFile)
    .filter((moduleName) => moduleName.startsWith("."))
    .map((moduleName) =>
      resolveRelativeSourceModule(moduleName, fileName, fileNameSet),
    )
    .filter((resolvedModule) => resolvedModule !== undefined)
    .map((resolvedModule) => resolvedModule.resolvedFileName);
}

function affectedExportFileNames({ ref, cwd, fileNames, seedFileNames }) {
  const fileNameSet = new Set(fileNames);
  const affected = new Set(
    seedFileNames.filter((fileName) => fileNameSet.has(fileName)),
  );
  let addedAffectedFile = true;
  while (addedAffectedFile) {
    addedAffectedFile = false;
    for (const fileName of fileNames) {
      if (affected.has(fileName)) continue;
      const targets = relativeExportTargets({
        ref,
        cwd,
        fileName,
        fileNameSet,
      });
      if (targets.some((target) => affected.has(target))) {
        affected.add(fileName);
        addedAffectedFile = true;
      }
    }
  }
  return affected;
}

function unresolvedModuleDiagnostics(program, sourceFile) {
  return ts
    .getPreEmitDiagnostics(program, sourceFile)
    .filter(
      (diagnostic) => diagnostic.code === 2307 || diagnostic.code === 2792,
    )
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    );
}

function throwOnUnresolvedExportModules({ program, sourceFile, file }) {
  const diagnostics = unresolvedModuleDiagnostics(program, sourceFile);
  if (diagnostics.length === 0) return;
  const unresolved = exportModuleSpecifiers(sourceFile).filter((moduleName) =>
    diagnostics.some((message) => message.includes(moduleName)),
  );
  if (unresolved.length === 0) return;
  throw new Error(
    `change-contract export extraction could not resolve public re-export module(s) in ${file}: ${unresolved.join(", ")}`,
  );
}

function exportsForSource({ file, ref, cwd, fileNames }) {
  if (!fileNames.includes(fileNameFor(file))) return [];
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
    if (isTypeScriptSourcePath(file.path)) paths.add(file.path);
    if (file.oldPath && isTypeScriptSourcePath(file.oldPath)) {
      paths.add(file.oldPath);
    }
  }
  return [...paths].sort(compareStrings);
}

function exportSet(exports) {
  return new Set(exports.map((entry) => exportKey(entry)));
}

function comparedSourcePaths({
  base,
  head,
  cwd,
  changedFiles,
  baseFileNames,
  headFileNames,
}) {
  const seedFileNames = changedTsPaths(changedFiles).map(fileNameFor);
  const baseAffected = affectedExportFileNames({
    ref: base,
    cwd,
    fileNames: baseFileNames,
    seedFileNames,
  });
  const headAffected = affectedExportFileNames({
    ref: head,
    cwd,
    fileNames: headFileNames,
    seedFileNames,
  });
  return [...new Set([...baseAffected, ...headAffected])]
    .map(pathForFileName)
    .sort(compareStrings);
}

/**
 * Compare exported symbols for changed TypeScript source files at two git refs.
 * @param {{ base: string, head: string, cwd: string, changedFiles: Array<{ path: string, oldPath: string | null }> }} params
 */
export function collectExportChanges({ base, head, cwd, changedFiles }) {
  const addedExports = [];
  const removedExports = [];
  if (changedTsPaths(changedFiles).length === 0) {
    return { addedExports, removedExports };
  }
  const baseFileNames = gitPathsAt({ ref: base, cwd }).map(fileNameFor);
  const headFileNames = gitPathsAt({ ref: head, cwd }).map(fileNameFor);
  const paths = comparedSourcePaths({
    base,
    head,
    cwd,
    changedFiles,
    baseFileNames,
    headFileNames,
  });
  for (const path of paths) {
    const before = exportsForSource({
      file: path,
      ref: base,
      cwd,
      fileNames: baseFileNames,
    });
    const after = exportsForSource({
      file: path,
      ref: head,
      cwd,
      fileNames: headFileNames,
    });
    const beforeKeys = exportSet(before);
    const afterKeys = exportSet(after);
    addedExports.push(
      ...after.filter((entry) => !beforeKeys.has(exportKey(entry))),
    );
    removedExports.push(
      ...before.filter((entry) => !afterKeys.has(exportKey(entry))),
    );
  }
  return {
    addedExports: addedExports.toSorted(compareExports),
    removedExports: removedExports.toSorted(compareExports),
  };
}
