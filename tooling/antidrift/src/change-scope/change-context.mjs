import { spawnSync } from "node:child_process";

import { collectExportChanges } from "./exports.mjs";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const GIT_DIFF_FILTER = "ACDMRTUXB";
const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const STATUS_OPERATION = Object.freeze({
  A: "add",
  M: "modify",
  D: "delete",
  R: "rename",
  C: "rename",
  T: "modify",
});
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Run git and fail loudly on any error. Never returns a partial result on failure.
 * @param {string[]} args
 * @param {string} cwd
 */
export function gitOrThrow(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd} (status ${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

/** @param {{ base: string, head: string, cwd: string }} params */
export function mergeBase({ base, head, cwd }) {
  const output = gitOrThrow(["merge-base", base, head], cwd).trim();
  if (output.length === 0) {
    throw new Error(`no merge-base between ${base} and ${head} in ${cwd}`);
  }
  return output;
}

/**
 * @param {{ base: string, head: string, cwd: string }} params
 * @returns {Array<{ status: string, operation: string, path: string, oldPath: string | null }>}
 */
export function changedFilesBetween({ base, head, cwd }) {
  const raw = gitOrThrow(
    [
      "diff",
      "--name-status",
      "--find-renames",
      "--ignore-submodules=none",
      `--diff-filter=${GIT_DIFF_FILTER}`,
      base,
      head,
    ],
    cwd,
  );
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    const letter = parts[0][0];
    const operation = STATUS_OPERATION[letter];
    if (operation === undefined) {
      throw new Error(
        `unsupported git status "${parts[0]}" for path ${parts[1] ?? ""} in ${cwd}`,
      );
    }
    if (letter === "R" || letter === "C") {
      entries.push({
        status: parts[0],
        operation,
        path: parts[2],
        oldPath: parts[1],
      });
    } else {
      entries.push({
        status: parts[0],
        operation,
        path: parts[1],
        oldPath: null,
      });
    }
  }
  return entries;
}

export function patchHunksBetween({ base, head, cwd }) {
  const raw = gitOrThrow(
    [
      "diff",
      "--unified=0",
      "--find-renames",
      "--ignore-submodules=none",
      `--diff-filter=${GIT_DIFF_FILTER}`,
      base,
      head,
    ],
    cwd,
  );
  const hunksByPath = {};
  let currentPath = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ b/") || line === "+++ /dev/null") {
      currentPath =
        line === "+++ /dev/null" ? null : line.replace(/^\+\+\+ b\//u, "");
      continue;
    }
    const match = HUNK_RE.exec(line);
    if (!match || currentPath === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    hunksByPath[currentPath] ??= [];
    hunksByPath[currentPath].push({ start, end: start + count - 1 });
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(hunksByPath).sort(([left], [right]) =>
        compareStrings(left, right),
      ),
    ),
  );
}

/**
 * Read a file at a git ref. Returns null when the file is absent at that ref.
 * @param {{ ref: string, path: string, cwd: string }} params
 */
export function fileAt({ ref, path, cwd }) {
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

/**
 * Read and parse a JSON manifest at a git ref. Returns null when the file is absent at that ref
 * (an added or deleted manifest); throws loudly when the manifest is present but unparseable.
 * @param {{ ref: string, path: string, cwd: string }} params
 */
function manifestAt(params) {
  const content = fileAt(params);
  return content === null ? null : JSON.parse(content);
}

function dependencyNames(manifest, fields) {
  const names = new Set();
  if (manifest === null) return names;
  for (const field of fields) {
    const block = manifest[field];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block)) names.add(name);
    }
  }
  return names;
}

function addedNames(before, after, fields) {
  const beforeNames = dependencyNames(before, fields);
  const added = [];
  for (const name of dependencyNames(after, fields)) {
    if (!beforeNames.has(name)) added.push(name);
  }
  return added;
}

/** @param {{ base: string, head: string, cwd: string, changedFiles: Array<{ path: string }> }} params */
export function addedDependencies({ base, head, cwd, changedFiles }) {
  const manifests = changedFiles
    .map((file) => file.path)
    .filter(
      (path) => path === "package.json" || path.endsWith("/package.json"),
    );
  const runtime = new Set();
  const dev = new Set();
  for (const manifestPath of manifests) {
    const before = manifestAt({ ref: base, path: manifestPath, cwd });
    const after = manifestAt({ ref: head, path: manifestPath, cwd });
    for (const name of addedNames(before, after, RUNTIME_DEPENDENCY_FIELDS)) {
      runtime.add(name);
    }
    for (const name of addedNames(before, after, ["devDependencies"])) {
      dev.add(name);
    }
  }
  return { runtime: [...runtime], dev: [...dev] };
}

/**
 * Collect the deterministic change surface between a base ref and head, diffed from their merge-base.
 * @param {{ base: string, head: string, cwd: string }} params
 */
export function collectChangeSurface({
  base,
  head,
  cwd,
  includeExports = true,
  includePatchHunks = true,
}) {
  const mergeBaseRef = mergeBase({ base, head, cwd });
  const changedFiles = changedFilesBetween({ base: mergeBaseRef, head, cwd });
  const patchHunks = includePatchHunks
    ? patchHunksBetween({ base: mergeBaseRef, head, cwd })
    : {};
  const { runtime, dev } = addedDependencies({
    base: mergeBaseRef,
    head,
    cwd,
    changedFiles,
  });
  const { addedExports, removedExports } = includeExports
    ? collectExportChanges({
        base: mergeBaseRef,
        head,
        cwd,
        changedFiles,
      })
    : { addedExports: [], removedExports: [] };
  return {
    mergeBase: mergeBaseRef,
    changedFiles,
    patchHunks,
    addedExports,
    removedExports,
    addedRuntimeDependencies: runtime,
    addedDevDependencies: dev,
  };
}
