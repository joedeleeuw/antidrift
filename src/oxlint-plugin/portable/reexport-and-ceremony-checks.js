import { packageOwner } from "./package-owner.js";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PLATFORM_SUFFIXES = ["ios", "android", "native", "web", "electron"];
const MODULE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

export function nonBlankLineCount(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

export function hasPlatformSibling(filename, stem) {
  if (!stem || !filename.startsWith("/")) return false;
  const dir = dirname(filename);
  for (const suffix of PLATFORM_SUFFIXES) {
    for (const ext of MODULE_EXTS) {
      if (existsSync(join(dir, `${stem}.${suffix}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

function collectManifestTargetStems(entry, stems = new Set()) {
  if (typeof entry === "string") {
    const normalized = entry
      .replace(/^\.\//u, "")
      .replace(/^dist\//u, "src/")
      .replace(/\.(?:d\.[cm]?ts|[cm]?[jt]sx?)$/u, "");
    stems.add(normalized);
    return stems;
  }
  if (entry && typeof entry === "object") {
    for (const child of Object.values(entry)) {
      collectManifestTargetStems(child, stems);
    }
  }
  return stems;
}

export function isDeclaredPackageIndex(filename) {
  if (!/\/index\.[cm]?[jt]sx?$/u.test(filename)) return false;
  if (!filename.startsWith("/")) {
    return /(?:^|\/)src\/index\.[cm]?[jt]sx?$|^index\.[cm]?[jt]sx?$/u.test(
      filename
    );
  }
  const owner = packageOwner(filename);
  if (!owner) {
    return /(?:^|\/)src\/index\.[cm]?[jt]sx?$/u.test(filename);
  }
  const relFile = relative(owner.directory, resolve(filename))
    .replaceAll("\\", "/")
    .replace(/\.[cm]?[jt]sx?$/u, "");
  if (relFile === "index" || relFile === "src/index") return true;
  const stems = collectManifestTargetStems({
    main: owner.manifest.main,
    module: owner.manifest.module,
    types: owner.manifest.types,
    bin: owner.manifest.bin,
    exports: owner.manifest.exports,
  });
  return stems.has(relFile);
}

function isOwnSliceReexport(stem, stmt) {
  if (!stem || typeof stmt.source?.value !== "string") return false;
  const src = stmt.source.value;
  return src.startsWith(`./${stem}.`) || src.startsWith(`./${stem}-`);
}

function collectFunctionParamTypeLines(stmt, sourceCode) {
  const decl =
    stmt.type === "ExportNamedDeclaration" ||
    stmt.type === "ExportDefaultDeclaration"
      ? stmt.declaration
      : stmt;
  if (decl?.type !== "FunctionDeclaration") return 0;
  return (decl.params ?? []).reduce(
    (sum, parameter) =>
      sum +
      (parameter.typeAnnotation
        ? nonBlankLineCount(sourceCode.getText(parameter.typeAnnotation))
        : 0),
    0
  );
}

function checkSplitModuleCeremony(programNode, context) {
  const sourceCode = context.sourceCode;
  const totalLines = nonBlankLineCount(sourceCode.text);
  if (totalLines <= 120) return;
  let ceremonyLines = 0;
  let typeDeclCount = 0;
  let runtimeFunctionCount = 0;
  for (const stmt of programNode.body) {
    const inner =
      stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
    if (
      stmt.type === "ImportDeclaration" ||
      (stmt.type === "ExportNamedDeclaration" && stmt.exportKind === "type")
    ) {
      ceremonyLines += nonBlankLineCount(sourceCode.getText(stmt));
      continue;
    }
    if (
      inner?.type === "TSInterfaceDeclaration" ||
      inner?.type === "TSTypeAliasDeclaration"
    ) {
      typeDeclCount += 1;
      ceremonyLines += nonBlankLineCount(sourceCode.getText(stmt));
      continue;
    }
    if (inner?.type === "FunctionDeclaration") {
      runtimeFunctionCount += 1;
      ceremonyLines += collectFunctionParamTypeLines(stmt, sourceCode);
    }
  }
  if (
    runtimeFunctionCount >= 1 &&
    typeDeclCount >= 1 &&
    ceremonyLines / totalLines > 0.35
  ) {
    context.report({
      node: programNode,
      message:
        "Module spends over 35% of its non-blank lines on import, type, and parameter ceremony; keep coupled helpers in their owning module.",
    });
  }
}

export function checkReexports(node, stem, context) {
  if (node.body.length === 0) return;
  const allReexports = node.body.every(
    (stmt) =>
      stmt.type === "ExportAllDeclaration" ||
      (stmt.type === "ExportNamedDeclaration" &&
        stmt.source !== null &&
        stmt.declaration === null)
  );
  if (allReexports) {
    if (node.body.every((stmt) => isOwnSliceReexport(stem, stmt))) {
      return;
    }
    context.report({
      node,
      message:
        "Module only re-exports symbols from other modules; import from the owning module directly.",
    });
    return;
  }
  for (const stmt of node.body) {
    if (
      stmt.type === "ExportNamedDeclaration" &&
      stmt.declaration === null &&
      stmt.exportKind !== "type" &&
      typeof stmt.source?.value === "string" &&
      stmt.source.value.startsWith("./") &&
      !isOwnSliceReexport(stem, stmt) &&
      stmt.specifiers.some((spec) => spec.exportKind !== "type")
    ) {
      context.report({
        node: stmt,
        message:
          "Do not re-export runtime symbols from a relative sibling in a non-index module; import from the owning module directly.",
      });
    }
  }
  checkSplitModuleCeremony(node, context);
}
