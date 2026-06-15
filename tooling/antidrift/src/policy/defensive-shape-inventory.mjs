import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

import antidrift from "../eslint-plugin/index.js";

const chaskiRepoCandidates = [
  process.env.CHASKI_REPO,
  "/Users/sushi/code/chaski",
].filter(Boolean);
const codebaseAtlasRepoCandidates = [
  process.env.CODEBASE_ATLAS_REPO,
  "/Users/sushi/code/codebase-atlas",
].filter(Boolean);
const sudocodeRepoCandidates = [
  process.env.SUDOCODE_REPO,
  "/Users/sushi/code/sudocode-main",
].filter(Boolean);
const opencodeRepoCandidates = [
  process.env.OPENCODE_REPO,
  "/Users/sushi/code/opencode",
].filter(Boolean);

const customRuleId = "antidrift/no-defensive-shape-probing";
const upstreamRuleIds = [
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-assignment",
];
const benchmarkRuleIds = [customRuleId, ...upstreamRuleIds];
const objectEntriesPattern = /Object\s*\.\s*entries\s*\(/u;
const transformMethodPattern =
  /\.(?:map|flatMap|reduce|filter|some|every|forEach)\s*\(/u;

const corpusPlans = [
  {
    repo: "chaski",
    label: "bff",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/bff/tsconfig.json",
    targets: ["src/frontend/bff/**/*.ts"],
  },
  {
    repo: "chaski",
    label: "portal",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/portal/tsconfig.json",
    targets: ["src/frontend/portal/**/*.{ts,tsx}"],
  },
  {
    repo: "codebase-atlas",
    label: "app",
    repoCandidates: codebaseAtlasRepoCandidates,
    tsconfig: "tsconfig.json",
    targets: ["src/**/*.{ts,tsx}", "tools/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "cli",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "cli/tsconfig.json",
    targets: ["cli/src/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "server",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "server/tsconfig.json",
    targets: ["server/src/**/*.ts"],
  },
  {
    repo: "opencode",
    label: "console-app",
    repoCandidates: opencodeRepoCandidates,
    tsconfig: "packages/console/app/tsconfig.json",
    targets: ["packages/console/app/src/**/*.{ts,tsx}"],
  },
];

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv) {
  const out = {
    repo: null,
    slice: "defensive-shape-inventory",
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--repo" && next) {
      out.repo = parseCsv(next);
      index += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      index += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      index += 1;
    }
  }
  return out;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function selectedPlans(repo, plans) {
  if (!repo) return plans;
  const requested = new Set(repo);
  return plans.filter((plan) => requested.has(plan.repo));
}

function lintConfig(repoRoot, tsconfig) {
  return [
    {
      ignores: [
        "**/node_modules/**",
        "**/__types_tmp/**",
        "**/dist/**",
        "**/.next/**",
        "**/.trunk/**",
        "**/.turbo/**",
        "**/coverage/**",
        "**/jest.*.ts",
        "**/*.d.ts",
        "**/*.d.mts",
        "**/*.d.cts",
      ],
    },
    {
      linterOptions: { reportUnusedDisableDirectives: "off" },
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          project: [resolve(repoRoot, tsconfig)],
          tsconfigRootDir: repoRoot,
        },
      },
      plugins: {
        "@typescript-eslint": tseslint.plugin,
        antidrift,
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

function countByRepo(results) {
  return Object.fromEntries(
    results.map((result) => [
      `${result.repo}/${result.label}`,
      result.findingsByRule?.[customRuleId] ?? 0,
    ]),
  );
}

function compare(findings) {
  const custom = findings.filter((finding) => finding.ruleId === customRuleId);
  const upstream = findings.filter((finding) =>
    upstreamRuleIds.includes(finding.ruleId),
  );
  const customKeys = new Set(custom.map(locationKey));
  const upstreamKeys = new Set(upstream.map(locationKey));
  const upstreamPaths = new Set(upstream.map((finding) => finding.path));
  return {
    overlapLocations: [...customKeys].filter((key) => upstreamKeys.has(key))
      .length,
    customOnlyLocations: custom.filter(
      (finding) => !upstreamKeys.has(locationKey(finding)),
    ).length,
    upstreamOnlyLocations: upstream.filter(
      (finding) => !customKeys.has(locationKey(finding)),
    ).length,
    customWithSameFileUpstream: custom.filter((finding) =>
      upstreamPaths.has(finding.path),
    ).length,
    customWithoutSameFileUpstream: custom.filter(
      (finding) => !upstreamPaths.has(finding.path),
    ).length,
  };
}

export function isEntryTransformCandidate(source) {
  return (
    objectEntriesPattern.test(source) && transformMethodPattern.test(source)
  );
}

function firstObjectEntriesLine(source) {
  const index = source.search(objectEntriesPattern);
  if (index < 0) return null;
  return source.slice(0, index).split(/\r?\n/u).length;
}

function syntaxCandidate(repoRoot, filePath) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!isEntryTransformCandidate(source)) return null;
  return {
    path: relative(repoRoot, filePath).replace(/\\/gu, "/"),
    line: firstObjectEntriesLine(source),
  };
}

async function runPlan(plan) {
  const repoRoot = firstExisting(plan.repoCandidates);
  if (!repoRoot) {
    return {
      repo: plan.repo,
      label: plan.label,
      decision: "skip",
      reason: `No repository found for ${plan.repo}.`,
    };
  }

  const eslint = new ESLint({
    cwd: repoRoot,
    errorOnUnmatchedPattern: false,
    overrideConfigFile: true,
    overrideConfig: lintConfig(repoRoot, plan.tsconfig),
  });
  const results = await eslint.lintFiles(plan.targets);
  const parserErrorFindings = results.flatMap((result) =>
    result.messages
      .filter((message) => message.fatal)
      .map((message) => toFinding(repoRoot, result, message)),
  );
  const findings = results.flatMap((result) =>
    result.messages
      .filter((message) => benchmarkRuleIds.includes(message.ruleId))
      .map((message) => toFinding(repoRoot, result, message)),
  );
  const syntaxCandidates = results
    .map((result) => syntaxCandidate(repoRoot, result.filePath))
    .filter(Boolean);

  return {
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    tsconfig: plan.tsconfig,
    targets: plan.targets,
    checkedFiles: results.length,
    syntaxCandidateFiles: syntaxCandidates.length,
    syntaxCandidateExamples: syntaxCandidates.slice(0, 20),
    parserErrors: parserErrorFindings.length,
    parserErrorFindings: parserErrorFindings.slice(0, 20),
    findingsByRule: countByRule(findings),
    comparison: compare(findings),
    findings,
  };
}

function summarize({ results, slice }) {
  const findings = results.flatMap((result) => result.findings ?? []);
  const checkedFiles = results.reduce(
    (sum, result) => sum + (result.checkedFiles ?? 0),
    0,
  );
  const parserErrors = results.reduce(
    (sum, result) => sum + (result.parserErrors ?? 0),
    0,
  );
  const syntaxCandidateFiles = results.reduce(
    (sum, result) => sum + (result.syntaxCandidateFiles ?? 0),
    0,
  );
  const driftRepositories = new Set(
    results
      .filter((result) => (result.findingsByRule?.[customRuleId] ?? 0) > 0)
      .map((result) => result.repo),
  );
  return {
    schemaVersion: 1,
    slice,
    decision: results.some((result) => result.decision === "pass")
      ? "pass"
      : "skip",
    benchmarkRules: benchmarkRuleIds,
    checkedFiles,
    syntaxCandidateFiles,
    parserErrors,
    driftRepositories: driftRepositories.size,
    findingsByRule: countByRule(findings),
    customFindingsByPlan: countByRepo(results),
    comparison: compare(findings),
    results,
  };
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

export async function defensiveShapeInventory({
  repo = null,
  slice = "defensive-shape-inventory",
  output = null,
  plans = corpusPlans,
  progress = console.error,
  report = console.log,
} = {}) {
  const results = [];
  await selectedPlans(repo, plans).reduce(
    (previous, plan) =>
      previous.then(async () => {
        progress(`[defensive-shape-inventory] scanning ${plan.repo}/${plan.label}`);
        const result = await runPlan(plan);
        progress(
          `[defensive-shape-inventory] ${plan.repo}/${plan.label}: ${result.checkedFiles ?? 0} files, ${result.syntaxCandidateFiles ?? 0} syntax candidates, ${result.findingsByRule?.[customRuleId] ?? 0} custom findings, ${result.parserErrors ?? 0} parser errors`,
        );
        results.push(result);
      }),
    Promise.resolve(),
  );
  const summary = summarize({ results, slice });
  emit(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await defensiveShapeInventory(parseArgs(process.argv.slice(2)));
}
