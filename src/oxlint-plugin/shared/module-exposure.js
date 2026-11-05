import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  declarationRoot,
  isStaticElementName,
  normalizedPath,
  programIndex,
  rootSymbols,
  workspaceSourceFiles,
} from "./program-references.js";

const OUTPUT_EXTENSION_RE = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const PROGRAM_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const SCRIPT_FILE_RE = /\.[cm]?jsx?$/u;
const ASSET_SPECIFIER_RE = /\.(?![cm]?[jt]sx?$)[a-z\d]+$/iu;
const EXPORT_SYNTAX_RE = /\bmodule\.exports\b|\bexports\s*[.[]|\bexport\s/u;

function exportTargets(exportsField) {
  if (typeof exportsField === "string") return [exportsField];
  if (Array.isArray(exportsField)) return exportsField.flatMap(exportTargets);
  if (exportsField && typeof exportsField === "object") {
    return Object.values(exportsField).flatMap(exportTargets);
  }
  return [];
}

function manifestTargets(manifest) {
  const manifestFields = [manifest.main, manifest.module, manifest.types]
    .concat(manifest.typings)
    .filter((target) => typeof target === "string")
    .map((target) => (target.startsWith(".") ? target : `./${target}`));
  return [...exportTargets(manifest.exports), ...manifestFields].filter(
    (target) => target.startsWith("./")
  );
}

function escapeRegExp(text) {
  return text.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function sourceCandidates(absolute, compilerOptions) {
  const candidates = [absolute];
  for (const outputDir of [
    compilerOptions.outDir,
    compilerOptions.declarationDir,
  ]) {
    if (!outputDir || !compilerOptions.rootDir) continue;
    const fromOutput = relative(outputDir, absolute);
    if (!fromOutput.startsWith("..")) {
      candidates.push(join(compilerOptions.rootDir, fromOutput));
    }
  }
  return candidates.map((candidate) =>
    normalizedPath(candidate).replace(OUTPUT_EXTENSION_RE, "")
  );
}

function entryFilesForTarget(absolute, exposure) {
  const stems = sourceCandidates(absolute, exposure.compilerOptions);
  if (absolute.includes("*")) {
    const patterns = stems.map(
      (stem) => new RegExp(`^${escapeRegExp(stem).replaceAll("\\*", ".+")}\\.`)
    );
    return exposure.programFiles.filter((sourceFile) =>
      patterns.some((pattern) => pattern.test(sourceFile.fileName))
    );
  }
  return stems.flatMap((stem) =>
    PROGRAM_EXTENSIONS.flatMap((extension) => {
      const sourceFile = exposure.filesByName.get(`${stem}${extension}`);
      return sourceFile ? [sourceFile] : [];
    })
  );
}

function exposesNothing(absolute) {
  return (
    SCRIPT_FILE_RE.test(absolute) &&
    existsSync(absolute) &&
    !EXPORT_SYNTAX_RE.test(readFileSync(absolute, "utf8"))
  );
}

function packageStatus(packageDir, exposure) {
  const known = exposure.packages.get(packageDir);
  if (known) return known;
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  );
  const status = { entryFiles: [], owned: true };
  for (const target of manifestTargets(manifest)) {
    const absolute = normalizedPath(resolve(packageDir, target));
    const entryFiles = entryFilesForTarget(absolute, exposure);
    status.entryFiles.push(...entryFiles);
    if (entryFiles.length === 0 && !exposesNothing(absolute)) {
      status.owned = false;
    }
  }
  exposure.packages.set(packageDir, status);
  return status;
}

function nearestPackageDir(directory, exposure) {
  if (exposure.packageDirs.has(directory)) {
    return exposure.packageDirs.get(directory);
  }
  const parent = dirname(directory);
  let packageDir = null;
  if (existsSync(join(directory, "package.json"))) packageDir = directory;
  else if (parent !== directory) {
    packageDir = nearestPackageDir(parent, exposure);
  }
  exposure.packageDirs.set(directory, packageDir);
  return packageDir;
}

function isModuleSymbol(symbol) {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      typeof declaration.fileName === "string" &&
      Array.isArray(declaration.statements)
  );
}

function protectModule(moduleSymbol, exposure, checker) {
  if (!moduleSymbol || exposure.protectedSymbols.has(moduleSymbol)) return;
  exposure.protectedSymbols.add(moduleSymbol);
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    for (const root of rootSymbols(exported, checker)) {
      if (isModuleSymbol(root)) protectModule(root, exposure, checker);
      else exposure.protectedSymbols.add(root);
    }
  }
}

function isMemberAccessOf(reference) {
  const access = reference.parent;
  return (
    access?.left === reference ||
    (access?.expression === reference &&
      (access.name !== undefined ||
        isStaticElementName(access.argumentExpression)))
  );
}

function escapedNamespaceModule(namespaceImport, sourceFile, services) {
  const { checker } = services;
  const namespaceSymbol = checker.getSymbolAtLocation(namespaceImport.name);
  const escapes = (
    programIndex(services).namesByText.get(namespaceImport.name.text) ?? []
  ).some(
    (reference) =>
      reference !== namespaceImport.name &&
      reference.getSourceFile() === sourceFile &&
      checker.getSymbolAtLocation(reference) === namespaceSymbol &&
      !isMemberAccessOf(reference)
  );
  return escapes ? rootSymbols(namespaceSymbol, checker)[0] : null;
}

function relativeProgramModule(specifier, exposure) {
  const fromDir = dirname(normalizedPath(specifier.getSourceFile().fileName));
  const stem = normalizedPath(resolve(fromDir, specifier.text)).replace(
    OUTPUT_EXTENSION_RE,
    ""
  );
  return [stem, `${stem}/index`]
    .flatMap((candidate) =>
      PROGRAM_EXTENSIONS.map((extension) => `${candidate}${extension}`)
    )
    .map((fileName) => exposure.filesByName.get(fileName))
    .find(Boolean);
}

function loadedModule(specifier, exposure, checker) {
  if (typeof specifier?.text !== "string" || specifier.escapedText) {
    return { moduleSymbol: null, unresolved: true };
  }
  const relativeTarget = specifier.text.startsWith(".")
    ? relativeProgramModule(specifier, exposure)
    : undefined;
  const moduleSymbol =
    checker.getSymbolAtLocation(specifier) ??
    (relativeTarget && checker.getSymbolAtLocation(relativeTarget));
  return {
    moduleSymbol,
    unresolved:
      !moduleSymbol &&
      specifier.text.startsWith(".") &&
      !ASSET_SPECIFIER_RE.test(specifier.text),
  };
}

function isImmediateMemberAccess(loadCall) {
  let loaded = loadCall;
  while (
    loaded.parent?.expression === loaded &&
    loaded.parent.name === undefined &&
    loaded.parent.argumentExpression === undefined &&
    loaded.parent.arguments === undefined &&
    /^(?:await\b|\()/u.test(loaded.parent.getText())
  ) {
    loaded = loaded.parent;
  }
  const access = loaded.parent;
  return (
    access?.expression === loaded &&
    (access.name !== undefined ||
      isStaticElementName(access.argumentExpression))
  );
}

function moduleLoadSpecifier(tsNode) {
  if (tsNode.moduleReference?.expression) {
    return { specifier: tsNode.moduleReference.expression };
  }
  if (!Array.isArray(tsNode.arguments)) return null;
  const callee = tsNode.expression?.getText();
  return (callee === "import" || callee === "require") &&
    !isImmediateMemberAccess(tsNode)
    ? { specifier: tsNode.arguments[0] }
    : null;
}

function escapedModules(tsNode, sourceFile, exposure, services) {
  const bindings = tsNode.importClause?.namedBindings;
  const loads = [];
  if (bindings?.name && !bindings.elements) {
    const moduleSymbol = escapedNamespaceModule(bindings, sourceFile, services);
    if (moduleSymbol) loads.push({ moduleSymbol, unresolved: false });
  }
  if (tsNode.exportClause?.name && !tsNode.exportClause.elements) {
    loads.push(
      loadedModule(tsNode.moduleSpecifier, exposure, services.checker)
    );
  }
  const load = moduleLoadSpecifier(tsNode);
  if (load) {
    loads.push(loadedModule(load.specifier, exposure, services.checker));
  }
  tsNode.forEachChild((child) => {
    loads.push(...escapedModules(child, sourceFile, exposure, services));
  });
  return loads;
}

function buildExposure(services) {
  const { checker, program } = services;
  const programFiles = program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.fileName.includes("/node_modules/"));
  const exposure = {
    compilerOptions: program.getCompilerOptions(),
    programFiles,
    filesByName: new Map(
      programFiles.map((sourceFile) => [sourceFile.fileName, sourceFile])
    ),
    packages: new Map(),
    packageDirs: new Map(),
    protectedSymbols: new Set(),
  };
  const loads = [];
  for (const sourceFile of workspaceSourceFiles(program)) {
    const packageDir = nearestPackageDir(
      dirname(normalizedPath(sourceFile.fileName)),
      exposure
    );
    const entryFiles =
      packageDir === null ? [] : packageStatus(packageDir, exposure).entryFiles;
    for (const entryFile of entryFiles) {
      loads.push({ moduleSymbol: checker.getSymbolAtLocation(entryFile) });
    }
    loads.push(...escapedModules(sourceFile, sourceFile, exposure, services));
  }
  for (const { moduleSymbol } of loads) {
    protectModule(moduleSymbol, exposure, checker);
  }
  return { ...exposure, programOpen: loads.some((load) => load.unresolved) };
}

export function isExposedOutsideProgram(nameNode, exported, services) {
  const index = programIndex(services);
  index.exposure ??= buildExposure(services);
  const { exposure } = index;
  if (exposure.programOpen) return true;
  const root = declarationRoot(nameNode, services.checker);
  if (!root || exposure.protectedSymbols.has(root)) return true;
  if (!exported) return false;
  const packageDir = nearestPackageDir(
    dirname(normalizedPath(nameNode.getSourceFile().fileName)),
    exposure
  );
  return packageDir !== null && !packageStatus(packageDir, exposure).owned;
}
