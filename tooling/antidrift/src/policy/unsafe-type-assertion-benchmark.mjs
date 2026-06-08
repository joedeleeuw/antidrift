import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
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

const benchmarkRuleIds = [
  "antidrift/no-appeasement-cast",
  "antidrift/no-unsafe-cast-chain",
  "antidrift/no-cast-to-branded",
  "@typescript-eslint/no-unsafe-type-assertion",
];
const antidriftRuleIds = benchmarkRuleIds.filter((ruleId) =>
  ruleId.startsWith("antidrift/"),
);
const upstreamRuleId = "@typescript-eslint/no-unsafe-type-assertion";

const corpusPlans = [
  {
    repo: "chaski",
    label: "portal",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/portal/tsconfig.json",
    targets: ["src/frontend/portal/**/*.{ts,tsx}"],
  },
  {
    repo: "chaski",
    label: "bff",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/bff/tsconfig.json",
    targets: ["src/frontend/bff/**/*.ts"],
  },
  {
    repo: "chaski",
    label: "monolithui",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/monolithui/tsconfig.json",
    targets: ["src/frontend/monolithui/**/*.{ts,tsx}"],
  },
  {
    repo: "chaski",
    label: "crow-v2",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/crow-v2/tsconfig.json",
    targets: ["src/frontend/crow-v2/**/*.{ts,tsx}"],
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
    label: "server",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "server/tsconfig.json",
    targets: ["server/**/*.{ts,tsx}"],
  },
  {
    repo: "sudocode-main",
    label: "frontend",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "frontend/tsconfig.json",
    targets: ["frontend/**/*.{ts,tsx}"],
  },
  {
    repo: "sudocode-main",
    label: "cli",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "cli/tsconfig.json",
    targets: ["cli/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "mcp",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "mcp/tsconfig.json",
    targets: ["mcp/**/*.ts"],
  },
];

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    repo: null,
    slice: "unsafe-type-assertion-benchmark",
    output: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--repo" && next) {
      out.repo = parseCsv(next);
      i += 1;
    } else if (arg === "--slice" && next) {
      out.slice = next;
      i += 1;
    } else if (arg === "--output" && next) {
      out.output = next;
      i += 1;
    }
  }
  return out;
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function selectedPlans(repo) {
  if (!repo) return corpusPlans;
  const requested = new Set(repo);
  return corpusPlans.filter((plan) => requested.has(plan.repo));
}

function eslintConfig(repoRoot, tsconfig) {
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

function compare(findings) {
  const upstream = findings.filter((finding) => finding.ruleId === upstreamRuleId);
  const antidriftFindings = findings.filter((finding) =>
    antidriftRuleIds.includes(finding.ruleId),
  );
  const upstreamKeys = new Set(upstream.map(locationKey));
  const antidriftKeys = new Set(antidriftFindings.map(locationKey));
  return {
    overlapLocations: [...upstreamKeys].filter((key) => antidriftKeys.has(key)).length,
    upstreamOnly: upstream.filter((finding) => !antidriftKeys.has(locationKey(finding))).length,
    antidriftOnly: antidriftFindings.filter((finding) => !upstreamKeys.has(locationKey(finding))).length,
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
    overrideConfigFile: true,
    overrideConfig: eslintConfig(repoRoot, plan.tsconfig),
  });
  const results = await eslint.lintFiles(plan.targets);
  const parserErrors = results.flatMap((result) =>
    result.messages
      .filter((message) => !message.ruleId)
      .map((message) => toFinding(repoRoot, result, message)),
  );
  const findings = results.flatMap((result) =>
    result.messages
      .filter((message) => benchmarkRuleIds.includes(message.ruleId))
      .map((message) => toFinding(repoRoot, result, message)),
  );

  return {
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    tsconfig: plan.tsconfig,
    targets: plan.targets,
    checkedFiles: results.length,
    parserErrors: parserErrors.length,
    findingsByRule: countByRule(findings),
    comparison: compare(findings),
    findings,
  };
}

function summarize(results, slice) {
  const checkedFiles = results.reduce(
    (sum, result) => sum + (result.checkedFiles ?? 0),
    0,
  );
  const parserErrors = results.reduce(
    (sum, result) => sum + (result.parserErrors ?? 0),
    0,
  );
  const findings = results.flatMap((result) => result.findings ?? []);
  const comparison = compare(findings);
  return {
    schemaVersion: 1,
    slice,
    decision: results.some((result) => result.decision === "pass")
      ? "pass"
      : "skip",
    benchmarkRules: benchmarkRuleIds,
    checkedFiles,
    parserErrors,
    findingsByRule: countByRule(findings),
    comparison,
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

export async function unsafeTypeAssertionBenchmark({
  repo = null,
  slice = "unsafe-type-assertion-benchmark",
  output = null,
  report = console.log,
} = {}) {
  const results = [];
  await selectedPlans(repo).reduce(
    (previous, plan) =>
      previous.then(async () => {
        results.push(await runPlan(plan));
      }),
    Promise.resolve(),
  );
  const summary = summarize(results, slice);
  emit(summary, output, report);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await unsafeTypeAssertionBenchmark(parseArgs(process.argv.slice(2)));
}

export { parseArgs };
