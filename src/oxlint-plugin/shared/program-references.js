import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SYMBOL_FLAG_ALIAS = 2_097_152;
const IGNORED_SOURCE_FILE_RE =
  /(?:^|\/)(?:node_modules|dist|build|coverage|_generated)\/|\.d\.[cm]?ts$/u;
const SCRIPT_EXTENSION_RE = /\.[cm]?[jt]sx?$/u;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];

const referenceIndexByProgram = new WeakMap();
const packageDirByDir = new Map();
const entryMatchersByPackageDir = new Map();

function normalizedPath(fileName) {
  return fileName.replaceAll("\\", "/");
}

function workspaceSourceFiles(program) {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        !IGNORED_SOURCE_FILE_RE.test(normalizedPath(sourceFile.fileName))
    );
}

function collectIdentifiers(tsNode, identifiersByName) {
  if (typeof tsNode.escapedText === "string") {
    const bucket = identifiersByName.get(tsNode.text);
    if (bucket) bucket.push(tsNode);
    else identifiersByName.set(tsNode.text, [tsNode]);
  }
  tsNode.forEachChild((child) => {
    collectIdentifiers(child, identifiersByName);
  });
}

function nearestPackageDir(directory) {
  if (packageDirByDir.has(directory)) return packageDirByDir.get(directory);
  const parent = dirname(directory);
  let packageDir = null;
  if (existsSync(join(directory, "package.json"))) packageDir = directory;
  else if (parent !== directory) packageDir = nearestPackageDir(parent);
  packageDirByDir.set(directory, packageDir);
  return packageDir;
}

function exportTargets(exportsField) {
  if (typeof exportsField === "string") return [exportsField];
  if (Array.isArray(exportsField)) return exportsField.flatMap(exportTargets);
  if (exportsField && typeof exportsField === "object") {
    return Object.values(exportsField).flatMap(exportTargets);
  }
  return [];
}

function escapeRegExp(text) {
  return text.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function entryMatcher(packageDir, target) {
  const absolute = normalizedPath(resolve(packageDir, target));
  const stem = absolute.replace(SCRIPT_EXTENSION_RE, "");
  const pattern = escapeRegExp(stem).replaceAll("*", ".+");
  const extensions = SOURCE_EXTENSIONS.map(escapeRegExp).join("|");
  return new RegExp(`^${pattern}(?:${extensions})$`, "u");
}

function packageEntryMatchers(packageDir) {
  if (entryMatchersByPackageDir.has(packageDir)) {
    return entryMatchersByPackageDir.get(packageDir);
  }
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  );
  const targets = [
    ...exportTargets(manifest.exports),
    ...[manifest.main, manifest.module, manifest.types, manifest.typings]
      .filter((target) => typeof target === "string")
      .map((target) => (target.startsWith(".") ? target : `./${target}`)),
  ].filter((target) => target.startsWith("./"));
  const matchers = targets.map((target) => entryMatcher(packageDir, target));
  entryMatchersByPackageDir.set(packageDir, matchers);
  return matchers;
}

function isPackageEntry(fileName) {
  const packageDir = nearestPackageDir(dirname(fileName));
  return (
    packageDir !== null &&
    packageEntryMatchers(packageDir).some((matcher) => matcher.test(fileName))
  );
}

export function canonicalSymbol(symbol, checker) {
  if (!symbol) return null;
  const target =
    (symbol.flags & SYMBOL_FLAG_ALIAS) === 0
      ? symbol
      : checker.getAliasedSymbol(symbol);
  return checker.getExportSymbolOfSymbol(target);
}

function entryExportedSymbols(program, checker) {
  const exported = new Set();
  for (const sourceFile of workspaceSourceFiles(program)) {
    if (!isPackageEntry(normalizedPath(sourceFile.fileName))) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
      exported.add(canonicalSymbol(exportSymbol, checker));
    }
  }
  return exported;
}

function programReferenceIndex(program, checker) {
  let index = referenceIndexByProgram.get(program);
  if (!index) {
    const identifiersByName = new Map();
    for (const sourceFile of workspaceSourceFiles(program)) {
      collectIdentifiers(sourceFile, identifiersByName);
    }
    index = { identifiersByName, entryExports: null };
    referenceIndexByProgram.set(program, index);
  }
  index.entryExports ??= entryExportedSymbols(program, checker);
  return index;
}

function referencedSymbol(identifier, checker) {
  return canonicalSymbol(
    checker.getShorthandAssignmentValueSymbol(identifier.parent) ??
      checker.getSymbolAtLocation(identifier),
    checker
  );
}

function moduleBindingSpecifier(identifier) {
  const specifier = identifier.parent;
  const isSpecifier =
    Array.isArray(specifier?.parent?.elements) &&
    (specifier.name === identifier || specifier.propertyName === identifier);
  if (!isSpecifier) return null;
  const bindingOwner = specifier.parent.parent;
  if (bindingOwner && "exportClause" in bindingOwner) return specifier;
  return bindingOwner?.parent && "importClause" in bindingOwner.parent
    ? specifier
    : null;
}

export function programReferences(nameNode, services) {
  const { checker, program } = services;
  const target = canonicalSymbol(
    checker.getSymbolAtLocation(nameNode),
    checker
  );
  if (!target) return null;
  const index = programReferenceIndex(program, checker);
  const references = [];
  const names = [nameNode.text];
  const visitedNames = new Set(names);
  for (const name of names) {
    for (const identifier of index.identifiersByName.get(name) ?? []) {
      if (identifier === nameNode) continue;
      if (referencedSymbol(identifier, checker) !== target) continue;
      const specifier = moduleBindingSpecifier(identifier);
      if (!specifier) {
        references.push(identifier);
        continue;
      }
      const alias = specifier.name?.text;
      if (alias && !visitedNames.has(alias)) {
        visitedNames.add(alias);
        names.push(alias);
      }
    }
  }
  return references;
}

export function isPackageEntryExport(nameNode, services) {
  const { checker, program } = services;
  const target = canonicalSymbol(
    checker.getSymbolAtLocation(nameNode),
    checker
  );
  return programReferenceIndex(program, checker).entryExports.has(target);
}
