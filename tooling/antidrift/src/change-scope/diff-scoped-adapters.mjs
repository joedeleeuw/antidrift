import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { collectChangeSurface } from "./change-context.mjs";
import { resolveNativeLinterBinary } from "../policy/oxlint.mjs";

const CODE_FILE_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/u;

const LinterFileResults = z.array(
  z.object({
    filePath: z.string(),
    messages: z.array(
      z.object({
        ruleId: z.string().nullable().optional(),
        line: z.number().optional(),
        column: z.number().optional(),
        severity: z.number(),
        message: z.string(),
        fatal: z.boolean().optional(),
      })
    ),
  })
);

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function relativePath(root, path) {
  return relative(root, resolve(root, path)).replace(/\\/gu, "/");
}

function codeFiles(changedFiles) {
  return changedFiles
    .filter(
      (file) => file.operation !== "delete" && CODE_FILE_RE.test(file.path)
    )
    .map((file) => file.path)
    .sort(compareStrings);
}

function lineInHunks(line, hunks) {
  return hunks.some((hunk) => line >= hunk.start && line <= hunk.end);
}

function inPatchHunks(entry, patchHunks) {
  if (typeof entry.line !== "number") return false;
  return lineInHunks(entry.line, patchHunks[entry.path] ?? []);
}

function findingFromMessage(cwd, result, message) {
  return {
    path: relativePath(cwd, result.filePath),
    ruleId: message.ruleId,
    line: message.line,
    column: message.column,
    severity: message.severity === 2 ? "error" : "warn",
    message: message.message,
    fatal: false,
  };
}

function countBy(entries, key) {
  const counts = {};
  for (const entry of entries) {
    const bucket = entry[key];
    if (typeof bucket !== "string" || bucket.length === 0) continue;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      compareStrings(left, right)
    )
  );
}

function writeJson(output, cwd, summary) {
  const target = resolve(cwd, output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`diff-scoped-adapters: ${flag} requires a value`);
  }
  return value;
}

const argumentOptions = {
  "--base": { field: "base", read: String },
  "--head": { field: "head", read: String },
  "--cwd": { field: "cwd", read: resolve },
  "--output": { field: "output", read: String },
  "--slice": { field: "slice", read: String },
};

export function parseArgs(argv) {
  const parsed = {
    base: process.env.ANTIDRIFT_BASE_REF ?? "HEAD",
    head: "HEAD",
    cwd: process.cwd(),
    output: null,
    slice: "diff-scoped-adapters",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const option = Object.hasOwn(argumentOptions, arg)
      ? argumentOptions[arg]
      : null;
    if (!option) {
      throw new Error(`diff-scoped-adapters: unknown argument "${arg}"`);
    }
    parsed[option.field] = option.read(requireValue(argv, index, arg));
    index += 1;
  }
  return parsed;
}

export async function diffScopedAdapters({
  base = process.env.ANTIDRIFT_BASE_REF ?? "HEAD",
  head = "HEAD",
  cwd = process.cwd(),
  output = null,
  slice = "diff-scoped-adapters",
  report = console.log,
} = {}) {
  const root = resolve(cwd);
  const surface = collectChangeSurface({ base, head, cwd: root });
  const targets = codeFiles(surface.changedFiles);
  let results = [];
  if (targets.length > 0) {
    const tempDir = mkdtempSync(resolve(tmpdir(), "antidrift-diff-scoped-"));
    const emptySuppressionsPath = resolve(tempDir, "suppressions.json");
    writeFileSync(emptySuppressionsPath, "{}\n", "utf8");
    try {
      const linterBinary = resolveNativeLinterBinary();
      const linterRun = spawnSync(
        linterBinary,
        [
          "--format",
          "json",
          "--suppressions-location",
          emptySuppressionsPath,
          ...targets,
        ],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }
      );
      if (linterRun.error) throw linterRun.error;
      const rawJson = (linterRun.stdout ?? "").trim();
      results =
        rawJson.length > 0 ? LinterFileResults.parse(JSON.parse(rawJson)) : [];
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  const allFindings = results
    .flatMap((result) =>
      result.messages.map((message) =>
        findingFromMessage(root, result, message)
      )
    )
    .sort((left, right) =>
      compareStrings(
        `${left.path}:${left.line}:${left.column}:${left.ruleId ?? ""}`,
        `${right.path}:${right.line}:${right.column}:${right.ruleId ?? ""}`
      )
    );
  const diffFindings = allFindings.filter((finding) =>
    inPatchHunks(finding, surface.patchHunks)
  );
  const summary = {
    schemaVersion: 1,
    command: "antidrift diff-scoped-adapters",
    slice,
    changeContext: { base, head, mergeBase: surface.mergeBase },
    checkedFiles: targets,
    hunkFiles: Object.keys(surface.patchHunks).sort(compareStrings),
    findingCounts: {
      total: allFindings.length,
      diffScoped: diffFindings.length,
      byRule: countBy(diffFindings, "ruleId"),
    },
    findings: diffFindings,
  };
  if (output) writeJson(output, root, summary);
  if (!output) report(JSON.stringify(summary, null, 2));
  return summary;
}

export async function diffScopedAdaptersCommand(argv) {
  return diffScopedAdapters(parseArgs(argv));
}
