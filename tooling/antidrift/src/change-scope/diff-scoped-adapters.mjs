import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { ESLint } from "eslint";

import { collectChangeSurface } from "./change-context.mjs";
import { semanticFactToJsonLine } from "../policy/lib/semantic-facts.mjs";

const CODE_FILE_RE = /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/u;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedPath(path) {
  return path.replace(/\\/gu, "/");
}

function relativePath(root, path) {
  return normalizedPath(relative(root, path));
}

function codeFiles(changedFiles) {
  return changedFiles
    .filter(
      (file) => file.operation !== "delete" && CODE_FILE_RE.test(file.path),
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
    ruleId: message.ruleId ?? null,
    line: message.line ?? null,
    column: message.column ?? null,
    severity: message.severity === 2 ? "error" : "warn",
    message: message.message,
    fatal: Boolean(message.fatal),
  };
}

function factEntry(fact) {
  return {
    factKind: fact.factKind,
    ruleId: fact.ruleId,
    adapterId: fact.adapterId,
    confidence: fact.confidence,
    path: normalizedPath(fact.filePath ?? ""),
    line: fact.location?.line ?? null,
    column: fact.location?.column ?? null,
    evidenceHash: fact.evidenceHash,
    factId: fact.factId,
    payload: fact.payload ?? {},
  };
}

function countBy(entries, key) {
  const counts = {};
  for (const entry of entries) {
    const value = entry[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );
}

function writeJson(output, cwd, summary) {
  const target = resolve(cwd, output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function writeFacts(output, cwd, facts) {
  const target = resolve(cwd, output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    facts.map((fact) => semanticFactToJsonLine(fact)).join(""),
    "utf8",
  );
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`diff-scoped-adapters: ${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const parsed = {
    base: process.env.ANTIDRIFT_BASE_REF ?? "HEAD",
    head: "HEAD",
    cwd: process.cwd(),
    output: null,
    factsOut: null,
    slice: "diff-scoped-adapters",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      parsed.base = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--head") {
      parsed.head = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--cwd") {
      parsed.cwd = resolve(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === "--output") {
      parsed.output = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--facts-out") {
      parsed.factsOut = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--slice") {
      parsed.slice = requireValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`diff-scoped-adapters: unknown argument "${arg}"`);
    }
  }
  return parsed;
}

export async function diffScopedAdapters({
  base = process.env.ANTIDRIFT_BASE_REF ?? "HEAD",
  head = "HEAD",
  cwd = process.cwd(),
  output = null,
  factsOut = null,
  slice = "diff-scoped-adapters",
  report = console.log,
} = {}) {
  const root = resolve(cwd);
  const surface = collectChangeSurface({ base, head, cwd: root });
  const targets = codeFiles(surface.changedFiles);
  const facts = [];
  const eslint = new ESLint({
    cwd: root,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: root,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });
  const results = targets.length > 0 ? await eslint.lintFiles(targets) : [];
  const allFindings = results
    .flatMap((result) =>
      result.messages.map((message) =>
        findingFromMessage(root, result, message),
      ),
    )
    .sort((left, right) =>
      compareStrings(
        `${left.path}:${left.line}:${left.column}:${left.ruleId ?? ""}`,
        `${right.path}:${right.line}:${right.column}:${right.ruleId ?? ""}`,
      ),
    );
  const diffFindings = allFindings.filter((finding) =>
    inPatchHunks(finding, surface.patchHunks),
  );
  const allFactEntries = facts
    .map(factEntry)
    .sort((left, right) =>
      compareStrings(
        `${left.path}:${left.line}:${left.factKind}:${left.evidenceHash}`,
        `${right.path}:${right.line}:${right.factKind}:${right.evidenceHash}`,
      ),
    );
  const diffFactEntries = allFactEntries.filter((fact) =>
    inPatchHunks(fact, surface.patchHunks),
  );
  const diffFactIds = new Set(diffFactEntries.map((fact) => fact.factId));
  const diffFacts = facts.filter((fact) => diffFactIds.has(fact.factId));
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
    factCounts: {
      total: allFactEntries.length,
      diffScoped: diffFactEntries.length,
      byFactKind: countBy(diffFactEntries, "factKind"),
    },
    findings: diffFindings,
    facts: diffFactEntries,
    decision: "inventory",
  };
  if (output) writeJson(output, root, summary);
  if (factsOut) writeFacts(factsOut, root, diffFacts);
  if (!output) report(JSON.stringify(summary, null, 2));
  return summary;
}

export async function diffScopedAdaptersCommand(argv) {
  return diffScopedAdapters(parseArgs(argv));
}
