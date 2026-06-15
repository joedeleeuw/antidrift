import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";

import plugin from "../eslint-plugin/index.js";

const defaultRepoCandidates = [
  process.env.CHASKI_REPO,
  "/Users/sushi/code/chaski",
].filter(Boolean);
const defaultTargets = ["src/frontend/**/*.{ts,tsx}"];
const defaultThreshold = 3;

function parseCsv(value) {
  const items = [];
  let current = "";
  let braceDepth = 0;
  for (const character of value) {
    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    }
    if (character === "," && braceDepth === 0) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  const out = {
    repoRoot: null,
    slice: "react-state-inventory",
    output: null,
    targets: defaultTargets,
    threshold: defaultThreshold,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--repo" && next) {
      out.repoRoot = next;
      index += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      index += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      index += 1;
    } else if ((arg === "--target" || arg === "--targets") && next) {
      out.targets = parseCsv(next);
      index += 1;
    } else if (arg === "--threshold" && next) {
      out.threshold = Number(next);
      index += 1;
    }
  }
  return out;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function repoRootFor(repoRoot) {
  if (repoRoot) return existsSync(repoRoot) ? resolve(repoRoot) : null;
  const found = firstExisting(defaultRepoCandidates);
  return found ? resolve(found) : null;
}

function cellEntries(payload) {
  return Object.values(payload?.cells ?? {}).filter(
    (entry) => entry && typeof entry === "object",
  );
}

function cellWrites(payload) {
  return cellEntries(payload).flatMap((entry) =>
    Array.isArray(entry.writes) ? entry.writes : [],
  );
}

function hasCellWith(payload, predicate) {
  return cellEntries(payload).some((entry) =>
    predicate(new Set(Array.isArray(entry.writes) ? entry.writes : [])),
  );
}

export function classifyReactStateFact(fact) {
  if (fact.factKind === "resourceLifecycleProof") {
    return "blocking-resource-lifecycle";
  }
  const payload = fact.payload ?? {};
  if (payload.requestGuard) return "request-guarded-transition";
  if (!payload.transition) return "synchronous-multi-cell-update";
  const writes = new Set(cellWrites(payload));
  const togglesBoolean = hasCellWith(
    payload,
    (cell) => cell.has("trueConst") && cell.has("falseConst"),
  );
  const hasLifecycleReset = writes.has("nullConst") || togglesBoolean;
  if (writes.has("awaited") && writes.has("caughtError") && hasLifecycleReset) {
    return "partial-resource-lifecycle";
  }
  if (writes.has("awaited")) return "async-resource-update";
  return "async-transition-co-mutation";
}

function factEntry(fact) {
  const payload = fact.payload ?? {};
  return {
    factKind: fact.factKind,
    bucket: classifyReactStateFact(fact),
    path: fact.filePath,
    line: fact.location?.line ?? null,
    column: fact.location?.column ?? null,
    evidenceHash: fact.evidenceHash,
    transition: Boolean(payload.transition),
    requestGuard: Boolean(payload.requestGuard),
    setterCount: payload.setterCount ?? 0,
    cells: payload.cells ?? {},
  };
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function countBy(entries, key) {
  const out = {};
  for (const entry of entries) increment(out, entry[key]);
  return Object.fromEntries(
    Object.entries(out).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function diagnosticsFor(repoRoot, results) {
  return results.flatMap((result) =>
    result.messages
      .filter(
        (message) => message.ruleId === "antidrift/no-handrolled-resource-lifecycle-cells",
      )
      .map((message) => ({
        path: relative(repoRoot, result.filePath).replace(/\\/gu, "/"),
        ruleId: message.ruleId,
        line: message.line,
        column: message.column,
        severity: message.severity === 2 ? "error" : "warn",
        message: message.message,
      })),
  );
}

function emit(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export async function reactStateInventory({
  repoRoot = null,
  targets = defaultTargets,
  slice = "react-state-inventory",
  output = null,
  threshold = defaultThreshold,
  report = console.log,
} = {}) {
  const root = repoRootFor(repoRoot);
  if (!root) {
    const summary = {
      schemaVersion: 1,
      corpus: "react-state",
      slice,
      decision: "skip",
      reason:
        "React state inventory repo not found. Pass --repo or set CHASKI_REPO.",
      facts: [],
    };
    emit(summary, output, report);
    return summary;
  }

  const facts = [];
  const eslint = new ESLint({
    cwd: root,
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,js,jsx}"],
        ignores: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/gen/**",
        ],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 2023,
          sourceType: "module",
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { antidrift: plugin },
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
        rules: {
          "antidrift/no-handrolled-resource-lifecycle-cells": ["error", { threshold }],
        },
      },
    ],
  });

  const results = await eslint.lintFiles(targets);
  const entries = facts
    .filter((fact) => fact.ruleId === "antidrift/no-handrolled-resource-lifecycle-cells")
    .map(factEntry)
    .sort((left, right) =>
      `${left.path}:${left.line}:${left.factKind}`.localeCompare(
        `${right.path}:${right.line}:${right.factKind}`,
      ),
    );
  const diagnostics = diagnosticsFor(root, results);
  const summary = {
    schemaVersion: 1,
    corpus: "react-state",
    slice,
    repoRoot: root,
    targets,
    threshold,
    checkedFiles: results.length,
    factCounts: countBy(entries, "factKind"),
    bucketCounts: countBy(entries, "bucket"),
    diagnosticCount: diagnostics.length,
    diagnostics,
    facts: entries,
    decision: "pass",
  };
  emit(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await reactStateInventory(parseArgs(process.argv.slice(2)));
}
