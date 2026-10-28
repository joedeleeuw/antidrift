import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const BANNED_FILENAMES = new Set([
  "common.rs",
  "helpers.rs",
  "misc.rs",
  "shared.rs",
  "util.rs",
  "utils.rs",
]);

const MAX_NON_BLANK_LINES = 500;

const KERNEL_LAYER_ORDER = new Map([
  ["provenance", 1],
  ["shape", 2],
  ["projection", 3],
  ["boundary", 4],
  ["callgraph", 5],
]);

function walkFiles(directoryPath, predicate, out = []) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, out);
    } else if (predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function stripStrings(line) {
  return line
    .replace(/r#+"[\s\S]*?"#+/gu, '""')
    .replace(/r"[^"]*"/gu, '""')
    .replace(/"(?:\\.|[^"\\])*"/gu, '""')
    .replace(/'(?:\\.|[^'\\])'/gu, "''");
}

function kernelLayerForFile(relativePath) {
  const prefix = "crates/antidrift-kernel/src/";
  if (!relativePath.startsWith(prefix)) {
    return 0;
  }
  const rest = relativePath.slice(prefix.length);
  const firstSegment = rest.split("/")[0]?.replace(/\.rs$/, "") ?? "";
  return KERNEL_LAYER_ORDER.get(firstSegment) ?? 0;
}

function checkLayerImports(relativePath, lineNumber, stripped, violations) {
  const callerLayer = kernelLayerForFile(relativePath);
  if (callerLayer <= 0) {
    return;
  }
  for (const [targetLayerName, targetRank] of KERNEL_LAYER_ORDER) {
    const directPattern = new RegExp(
      `\\b(?:crate|super)::${targetLayerName}\\b`,
      "u"
    );
    const groupedPattern = new RegExp(
      `\\buse\\s+(?:crate|super)::\\{[^}]*\\b${targetLayerName}\\b`,
      "u"
    );
    if (
      targetRank > callerLayer &&
      (directPattern.test(stripped) || groupedPattern.test(stripped))
    ) {
      violations.push(
        `${relativePath}:${lineNumber} lower semantic layer (rank ${callerLayer}) cannot import higher layer '${targetLayerName}' (rank ${targetRank})`
      );
    }
  }
}

function checkRustLine(relativePath, lineNumber, rawLine, violations) {
  const stripped = stripStrings(rawLine);
  if (stripped.includes("//")) {
    violations.push(
      `${relativePath}:${lineNumber} inline comment prohibited in crates/ source`
    );
  }
  if (
    /#\[\s*(?:tokio::)?test\b/u.test(stripped) ||
    /#\[\s*cfg\s*\(\s*test\s*\)/u.test(stripped)
  ) {
    violations.push(
      `${relativePath}:${lineNumber} inline unit test attribute prohibited in crates/ source`
    );
  }
  checkLayerImports(relativePath, lineNumber, stripped, violations);
}

function checkRustFile(repoRoot, filePath, violations) {
  const relativePath = path.relative(repoRoot, filePath).replaceAll("\\", "/");
  const baseName = path.basename(filePath);
  if (BANNED_FILENAMES.has(baseName)) {
    violations.push(
      `${relativePath}:1 banned catch-all module filename '${baseName}'`
    );
  }
  const lines = readFileSync(filePath, "utf8").split("\n");
  const nonBlankCount = lines.filter((line) => line.trim().length > 0).length;
  if (nonBlankCount > MAX_NON_BLANK_LINES) {
    violations.push(
      `${relativePath}:1 file has ${nonBlankCount} non-blank lines (max ${MAX_NON_BLANK_LINES})`
    );
  }
  for (let index = 0; index < lines.length; index += 1) {
    checkRustLine(relativePath, index + 1, lines[index] ?? "", violations);
  }
}

function checkCrateManifest(repoRoot, manifestPath, violations) {
  const relativePath = path
    .relative(repoRoot, manifestPath)
    .replaceAll("\\", "/");
  const text = readFileSync(manifestPath, "utf8");
  if (!/\[lints\]\s*workspace\s*=\s*true/.test(text)) {
    violations.push(
      `${relativePath}:1 missing '[lints] workspace = true' in crate Cargo.toml`
    );
  }
  if (!/test\s*=\s*false/.test(text)) {
    violations.push(
      `${relativePath}:1 missing 'test = false' on [lib] or [[bin]] target`
    );
  }
  if (
    relativePath === "crates/antidrift-kernel/Cargo.toml" &&
    /\bantidrift-(?:rules|linter)\b/u.test(text)
  ) {
    violations.push(
      `${relativePath}:1 antidrift-kernel cannot depend on antidrift-rules or antidrift-linter`
    );
  }
  if (
    relativePath === "crates/antidrift-rules/Cargo.toml" &&
    /\bantidrift-linter\b/u.test(text)
  ) {
    violations.push(
      `${relativePath}:1 antidrift-rules cannot depend on antidrift-linter`
    );
  }
}

const repoRoot = process.cwd();
const cratesDir = path.join(repoRoot, "crates");
const violations = [];

if (statSync(cratesDir, { throwIfNoEntry: false })?.isDirectory()) {
  const manifests = walkFiles(
    cratesDir,
    (candidate) => path.basename(candidate) === "Cargo.toml"
  );
  for (const manifestPath of manifests) {
    checkCrateManifest(repoRoot, manifestPath, violations);
  }
  const rustFiles = walkFiles(cratesDir, (candidate) =>
    candidate.endsWith(".rs")
  );
  for (const filePath of rustFiles) {
    checkRustFile(repoRoot, filePath, violations);
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(`${violation}\n`);
  }
  process.exit(1);
}
