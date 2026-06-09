import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";

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
const cloudflareAgentsRepoCandidates = [
  process.env.CLOUDFLARE_AGENTS_REPO,
  "/Users/sushi/code/cloudflare-agents",
].filter(Boolean);
const opencodeRepoCandidates = [
  process.env.OPENCODE_REPO,
  "/Users/sushi/code/opencode",
].filter(Boolean);
const powersyncServiceRepoCandidates = [
  process.env.POWERSYNC_SERVICE_REPO,
  "/Users/sushi/code/powersync-service",
].filter(Boolean);

const benchmarkRuleIds = [
  "antidrift/no-sql-string-concat",
  "sonarjs/sql-queries",
];
const customRuleId = "antidrift/no-sql-string-concat";
const upstreamRuleId = "sonarjs/sql-queries";

const corpusPlans = [
  {
    repo: "chaski",
    label: "bff-sql-corpus",
    repoCandidates: chaskiRepoCandidates,
    targets: [
      "src/frontend/bff/api/gateways/posthog-gateway.ts",
      "src/frontend/bff/api/gateways/bigquery-gateway.ts",
    ],
  },
  {
    repo: "codebase-atlas",
    label: "app",
    repoCandidates: codebaseAtlasRepoCandidates,
    targets: ["src/**/*.{ts,tsx}", "tools/**/*.ts"],
  },
  {
    repo: "sudocode-main",
    label: "server-sql-corpus",
    repoCandidates: sudocodeRepoCandidates,
    targets: [
      "server/src/routes/workflows.ts",
      "server/src/workflow/base-workflow-engine.ts",
      "server/src/routes/config.ts",
    ],
  },
  {
    repo: "sudocode-main-cli",
    label: "cli-sql-corpus",
    repoCandidates: sudocodeRepoCandidates,
    targets: [
      "cli/src/operations/issues.ts",
      "cli/src/operations/specs.ts",
      "cli/src/operations/tags.ts",
      "cli/src/operations/relationships.ts",
    ],
  },
  {
    repo: "cloudflare-agents",
    label: "sql-corpus",
    repoCandidates: cloudflareAgentsRepoCandidates,
    targets: [
      "packages/shell/src/filesystem.ts",
      "examples/codemode/src/tools.ts",
      "examples/playground/src/demos/core/SqlDemo.tsx",
      "packages/ai-chat/e2e/chat.spec.ts",
      "packages/voice/src/voice.ts",
      "packages/ai-chat/src/index.ts",
      "packages/agents/src/index.ts",
    ],
  },
  {
    repo: "opencode",
    label: "drizzle-sql-corpus",
    repoCandidates: opencodeRepoCandidates,
    targets: [
      "packages/effect-drizzle-sqlite/src/up-migrations/effect-sqlite.ts",
      "packages/effect-drizzle-sqlite/src/up-migrations/sqlite.ts",
      "packages/effect-drizzle-sqlite/src/sqlite-core/effect/session.ts",
      "packages/core/src/database/migration.ts",
    ],
  },
  {
    repo: "powersync-service",
    label: "module-mysql-sql-corpus",
    repoCandidates: powersyncServiceRepoCandidates,
    tsconfig: "modules/module-mysql/tsconfig.json",
    targets: [
      "modules/module-mysql/src/api/MySQLRouteAPIAdapter.ts",
      "modules/module-mysql/src/replication/BinLogStream.ts",
    ],
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
    slice: "sql-query-benchmark",
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

function eslintConfig(plan, repoRoot) {
  const parserOptions = {
    ecmaFeatures: { jsx: true },
    ecmaVersion: 2023,
    sourceType: "module",
  };
  if (plan.tsconfig) {
    parserOptions.project = [plan.tsconfig];
    parserOptions.tsconfigRootDir = repoRoot;
  }
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
        parserOptions,
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
  const upstream = findings.filter((finding) => finding.ruleId === upstreamRuleId);
  const customKeys = new Set(custom.map(locationKey));
  const upstreamKeys = new Set(upstream.map(locationKey));
  return {
    overlapLocations: [...customKeys].filter((key) => upstreamKeys.has(key)).length,
    customOnly: custom.filter((finding) => !upstreamKeys.has(locationKey(finding))).length,
    upstreamOnly: upstream.filter((finding) => !customKeys.has(locationKey(finding))).length,
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
    overrideConfig: eslintConfig(plan, repoRoot),
  });
  const results = await eslint.lintFiles(plan.targets);
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
    repo: plan.repo,
    label: plan.label,
    decision: "pass",
    repoRoot,
    targets: plan.targets,
    typeAware: Boolean(plan.tsconfig),
    tsconfig: plan.tsconfig ?? null,
    checkedFiles: results.length,
    parserErrors: parserErrors.length,
    parserErrorFindings: parserErrors.slice(0, 10),
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

export async function sqlQueryBenchmark({
  repo = null,
  slice = "sql-query-benchmark",
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
  await sqlQueryBenchmark(parseArgs(process.argv.slice(2)));
}

export { parseArgs };
