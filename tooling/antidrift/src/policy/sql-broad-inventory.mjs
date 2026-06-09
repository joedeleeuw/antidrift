import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";

import antidrift from "../eslint-plugin/index.js";

const defaultCodeRoot = process.env.CODE_ROOT ?? "/Users/sushi/code";
const defaultExcludes = ["agent-guardrails-monorepo-template", "chaski"];
const ignoredDirectoryNames = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const benchmarkRuleIds = [
  "antidrift/no-sql-string-concat",
  "sonarjs/sql-queries",
];
const customRuleId = "antidrift/no-sql-string-concat";
const upstreamRuleId = "sonarjs/sql-queries";
const sqlCandidatePattern =
  /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|DROP\s+TABLE\b|\bsql\b|HogQL)\b/iu;

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    codeRoot: defaultCodeRoot,
    exclude: defaultExcludes,
    output: null,
    repo: null,
    slice: "sql-broad-inventory",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--code-root" && next) {
      out.codeRoot = next;
      i += 1;
    } else if (arg === "--exclude" && next) {
      out.exclude = parseCsv(next);
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    } else if (arg === "--repo" && next) {
      out.repo = parseCsv(next);
      i += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    }
  }
  return out;
}

function extensionOf(path) {
  const match = /\.[^.]+$/u.exec(path);
  return match?.[0] ?? "";
}

function shouldSkipDirectory(path) {
  return ignoredDirectoryNames.has(basename(path));
}

function isRepoRoot(path) {
  return (
    existsSync(resolve(path, ".git")) ||
    existsSync(resolve(path, "package.json"))
  );
}

function candidateRepoRoots(codeRoot, excludes, repo) {
  if (!existsSync(codeRoot)) return [];
  const excluded = new Set(excludes);
  const requested = repo ? new Set(repo) : null;
  return readdirSync(codeRoot)
    .map((entry) => resolve(codeRoot, entry))
    .filter((path) => {
      const name = basename(path);
      if (requested && !requested.has(name)) return false;
      if (excluded.has(name)) return false;
      if (!statSync(path).isDirectory()) return false;
      return isRepoRoot(path);
    })
    .sort((a, b) => a.localeCompare(b));
}

function sourceFilesUnder(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = resolve(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!shouldSkipDirectory(path)) walk(path);
      } else if (stats.isFile() && sourceExtensions.has(extensionOf(path))) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

function isSqlCandidate(path) {
  try {
    return sqlCandidatePattern.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function lintConfig() {
  return [
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/.turbo/**",
        "**/coverage/**",
        "**/*.d.ts",
        "**/*.d.mts",
        "**/*.d.cts",
      ],
    },
    {
      files: ["**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}"],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          ecmaFeatures: { jsx: true },
          ecmaVersion: 2023,
          sourceType: "module",
        },
      },
      plugins: {
        antidrift,
        sonarjs,
      },
      rules: Object.fromEntries(
        benchmarkRuleIds.map((ruleId) => [ruleId, "error"]),
      ),
    },
  ];
}

function toFinding(repoRoot, result, message) {
  return {
    path: relative(repoRoot, result.filePath).replace(/\\/gu, "/"),
    ruleId: message.ruleId,
    line: message.line,
    column: message.column,
    message: message.message,
  };
}

function locationKey(finding) {
  return `${finding.path}:${finding.line}`;
}

function countByRule(findings) {
  return Object.fromEntries(
    benchmarkRuleIds.map((ruleId) => [
      ruleId,
      findings.filter((finding) => finding.ruleId === ruleId).length,
    ]),
  );
}

function compare(findings) {
  const custom = findings.filter((finding) => finding.ruleId === customRuleId);
  const upstream = findings.filter(
    (finding) => finding.ruleId === upstreamRuleId,
  );
  const customKeys = new Set(custom.map(locationKey));
  const upstreamKeys = new Set(upstream.map(locationKey));
  return {
    overlapLocations: [...customKeys].filter((key) => upstreamKeys.has(key))
      .length,
    customOnly: custom.filter(
      (finding) => !upstreamKeys.has(locationKey(finding)),
    ).length,
    upstreamOnly: upstream.filter(
      (finding) => !customKeys.has(locationKey(finding)),
    ).length,
  };
}

async function lintRepository(repoRoot) {
  const candidateFiles = sourceFilesUnder(repoRoot).filter(isSqlCandidate);
  if (candidateFiles.length === 0) {
    return {
      repo: basename(repoRoot),
      repoRoot,
      candidateFiles: 0,
      parserErrors: 0,
      findingsByRule: countByRule([]),
      comparison: compare([]),
      parserErrorFindings: [],
      findings: [],
    };
  }

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: lintConfig(),
  });
  const results = await eslint.lintFiles(candidateFiles);
  const parserErrors = results.flatMap((result) =>
    result.messages
      .filter((message) => message.fatal)
      .map((message) => toFinding(repoRoot, result, message)),
  );
  const findings = results.flatMap((result) =>
    result.messages
      .filter((message) => benchmarkRuleIds.includes(message.ruleId))
      .map((message) => toFinding(repoRoot, result, message)),
  );

  return {
    repo: basename(repoRoot),
    repoRoot,
    candidateFiles: results.length,
    parserErrors: parserErrors.length,
    findingsByRule: countByRule(findings),
    comparison: compare(findings),
    parserErrorFindings: parserErrors.slice(0, 20),
    findings,
  };
}

function summarize({ slice, codeRoot, exclude, repo, results }) {
  const findings = results.flatMap((result) => result.findings);
  const checkedRepositories = results.filter(
    (result) => result.candidateFiles > 0,
  ).length;
  return {
    schemaVersion: 1,
    slice,
    codeRoot,
    exclude,
    repo,
    benchmarkRules: benchmarkRuleIds,
    repositories: results.length,
    checkedRepositories,
    candidateFiles: results.reduce(
      (sum, result) => sum + result.candidateFiles,
      0,
    ),
    parserErrors: results.reduce((sum, result) => sum + result.parserErrors, 0),
    findingsByRule: countByRule(findings),
    comparison: compare(findings),
    results,
  };
}

function emit(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
}

export async function sqlBroadInventory({
  codeRoot = defaultCodeRoot,
  exclude = defaultExcludes,
  output = null,
  repo = null,
  slice = "sql-broad-inventory",
  progress = console.error,
  report = console.log,
} = {}) {
  const root = resolve(codeRoot);
  const repoRoots = candidateRepoRoots(root, exclude, repo);
  const results = [];
  await repoRoots.reduce(
    (previous, repoRoot) =>
      previous.then(async () => {
        progress(`[sql-broad-inventory] scanning ${basename(repoRoot)}`);
        const result = await lintRepository(repoRoot);
        progress(
          `[sql-broad-inventory] ${result.repo}: ${result.candidateFiles} candidates, ${result.findingsByRule[customRuleId]} custom findings, ${result.parserErrors} parser errors`,
        );
        results.push(result);
      }),
    Promise.resolve(),
  );
  const summary = summarize({ slice, codeRoot: root, exclude, repo, results });
  emit(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await sqlBroadInventory(parseArgs(process.argv.slice(2)));
}

export { parseArgs };
