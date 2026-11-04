import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTestFile } from "./scope.js";

const STRING_LITERAL_TOKEN_RE = /["']([^"'\\\n]+)["']/gu;
const EXPORTED_UNION_RE =
  /export\s+(?:type|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:((?:["'][^"'\\\n]+["']\s*\|\s*)+["'][^"'\\\n]+["'])|(?:\[\s*((?:["'][^"'\\\n]+["']\s*,\s*)+["'][^"'\\\n]+["']\s*,?)\s*\]\s*as\s+const)|(?:[A-Za-z_$][\w$]*\.(?:enum|picklist)\(\s*\[\s*((?:["'][^"'\\\n]+["']\s*,\s*)+["'][^"'\\\n]+["']\s*,?)\s*\]\s*\)))/gu;
const UNLOADED_SEAM_IMPL_RE =
  /\b(?:implements|satisfies)\s+([A-Za-z_$][\w$]*)|:\s*([A-Za-z_$][\w$]*)\s*=\s*\{/gu;

export function contentSignature(text) {
  let hash = 2_166_136_261;
  const step = Math.max(1, Math.floor(text.length / 512));
  for (let idx = 0; idx < text.length; idx += step) {
    hash ^= text.charCodeAt(idx);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function createEmptyFileSnapshot(fileName, origin, astOnly) {
  return {
    fileName,
    origin,
    signature: "",
    astOnly,
    exportedOwners: [],
    unionOwners: [],
    declaredNames: new Set(),
    implementedSeams: new Map(),
    callStats: new Map(),
    importCounts: new Map(),
    isEffectModule: false,
  };
}

function parseLiteralList(rawTokens) {
  const literals = [...rawTokens.matchAll(STRING_LITERAL_TOKEN_RE)].map(
    (match) => match[1]
  );
  const unique = [...new Set(literals)].toSorted();
  return unique.length >= 2 && unique.length === literals.length
    ? unique
    : null;
}

function stripCommentsForScan(text) {
  return text.replaceAll(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
    (_match, literal) => literal ?? " "
  );
}

function buildUnloadedPackageSnapshot(fileName, text, packagePriority) {
  const snapshot = createEmptyFileSnapshot(fileName, "package", true);
  snapshot.signature = contentSignature(text);
  const cleanText = stripCommentsForScan(text);
  for (const match of cleanText.matchAll(EXPORTED_UNION_RE)) {
    const name = match[1];
    const rawList = match.slice(2).find(Boolean);
    const literals = name && rawList ? parseLiteralList(rawList) : null;
    if (!literals) continue;
    snapshot.declaredNames.add(name);
    snapshot.unionOwners.push({
      name,
      fileName,
      origin: "package",
      priority: packagePriority,
      literals,
      unionKey: literals.join("|"),
    });
  }
  for (const match of cleanText.matchAll(UNLOADED_SEAM_IMPL_RE)) {
    const seamName = match.slice(1).find(Boolean);
    if (!seamName) continue;
    let bucket = snapshot.implementedSeams.get(seamName);
    if (!bucket) {
      bucket = new Set();
      snapshot.implementedSeams.set(seamName, bucket);
    }
    bucket.add(`${fileName}:${match.index ?? 0}`);
  }
  return snapshot;
}

function collectPackageTsFiles(dirPath, depth, collectedFiles) {
  if (depth > 5 || !existsSync(dirPath)) return;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const fullPath = join(dirPath, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      collectPackageTsFiles(fullPath, depth + 1, collectedFiles);
    } else if (
      entry.isFile() &&
      /\.[cm]?tsx?$/u.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !isTestFile(fullPath)
    ) {
      collectedFiles.push(fullPath);
    }
  }
}

export function syncUnloadedWorkspacePackages(workspaceState, packagePriority) {
  if (!workspaceState.packageFiles) {
    workspaceState.packageFiles = [];
    for (const subdir of ["packages", "apps"]) {
      const dir = join(workspaceState.root, subdir);
      if (existsSync(dir)) {
        collectPackageTsFiles(dir, 0, workspaceState.packageFiles);
      }
    }
  }
  if (workspaceState.packageFiles.length === 0) return false;
  let changed = false;
  for (const fileName of workspaceState.packageFiles) {
    const existing = workspaceState.fileSnapshots.get(fileName);
    if (existing && !existing.astOnly) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(fileName).mtimeMs;
    } catch {
      if (existing) {
        workspaceState.fileSnapshots.delete(fileName);
        changed = true;
      }
      continue;
    }
    if (existing && existing.mtimeMs === mtimeMs) continue;
    try {
      const text = readFileSync(fileName, "utf8");
      const snapshot = buildUnloadedPackageSnapshot(
        fileName,
        text,
        packagePriority
      );
      snapshot.mtimeMs = mtimeMs;
      workspaceState.fileSnapshots.set(fileName, snapshot);
      changed = true;
    } catch {
      continue;
    }
  }
  return changed;
}

export function resolveWorkspaceRoot(program) {
  const startDir = (
    program.getCurrentDirectory?.() ?? process.cwd()
  ).replaceAll("\\", "/");
  let cur = startDir;
  let candidate = startDir;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      existsSync(join(cur, "pnpm-workspace.yaml")) ||
      existsSync(join(cur, ".git")) ||
      existsSync(join(cur, "packages"))
    ) {
      return cur;
    }
    if (existsSync(join(cur, "package.json"))) {
      candidate = cur;
    }
    const parent = dirname(cur).replaceAll("\\", "/");
    if (parent === cur) break;
    cur = parent;
  }
  return candidate;
}
