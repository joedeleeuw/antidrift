import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import ts from "typescript";
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

const customRuleId = "antidrift/no-underchecked-type-predicate";
const upstreamRuleIds = [
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-type-assertion",
];
const benchmarkRuleIds = [customRuleId, ...upstreamRuleIds];

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
    label: "monolithui",
    repoCandidates: chaskiRepoCandidates,
    tsconfig: "src/frontend/monolithui/tsconfig.json",
    targets: ["src/frontend/monolithui/src/**/*.{ts,tsx}"],
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
    label: "frontend",
    repoCandidates: sudocodeRepoCandidates,
    tsconfig: "frontend/tsconfig.json",
    targets: ["frontend/src/**/*.{ts,tsx}"],
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
    label: "ui",
    repoCandidates: opencodeRepoCandidates,
    tsconfig: "packages/ui/tsconfig.json",
    targets: ["packages/ui/src/**/*.{ts,tsx}"],
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
    slice: "underchecked-predicate-inventory",
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
        "**/*.stories.*",
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

function hasTypePredicate(node) {
  return node.type?.kind === ts.SyntaxKind.TypePredicate;
}

export function countTypePredicateCandidates(source, fileName = "file.ts") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  let count = 0;
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      hasTypePredicate(node)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

function firstTypePredicateLine(source, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  let line = null;
  function visit(node) {
    if (line !== null) return;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      hasTypePredicate(node)
    ) {
      line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return line;
}

function syntaxCandidate(repoRoot, filePath) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const candidateCount = countTypePredicateCandidates(source, filePath);
  if (candidateCount === 0) return null;
  return {
    path: relative(repoRoot, filePath).replace(/\\/gu, "/"),
    line: firstTypePredicateLine(source, filePath),
    candidateCount,
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
    syntaxCandidateCount: syntaxCandidates.reduce(
      (sum, candidate) => sum + candidate.candidateCount,
      0,
    ),
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
  const publicResults = results.map((result) => {
    const { findings: planFindings = [], ...publicResult } = result;
    return {
      ...publicResult,
      customFindings: planFindings.filter(
        (finding) => finding.ruleId === customRuleId,
      ),
    };
  });
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
  const syntaxCandidateCount = results.reduce(
    (sum, result) => sum + (result.syntaxCandidateCount ?? 0),
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
    syntaxCandidateCount,
    parserErrors,
    driftRepositories: driftRepositories.size,
    findingsByRule: countByRule(findings),
    customFindingsByPlan: countByRepo(results),
    comparison: compare(findings),
    results: publicResults,
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

export async function undercheckedPredicateInventory({
  repo = null,
  slice = "underchecked-predicate-inventory",
  output = null,
  plans = corpusPlans,
  progress = console.error,
  report = console.log,
} = {}) {
  const results = [];
  await selectedPlans(repo, plans).reduce(
    (previous, plan) =>
      previous.then(async () => {
        progress(
          `[underchecked-predicate-inventory] scanning ${plan.repo}/${plan.label}`,
        );
        const result = await runPlan(plan);
        progress(
          `[underchecked-predicate-inventory] ${plan.repo}/${plan.label}: ${result.checkedFiles ?? 0} files, ${result.syntaxCandidateFiles ?? 0} predicate candidate files, ${result.findingsByRule?.[customRuleId] ?? 0} custom findings, ${result.parserErrors ?? 0} parser errors`,
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
  await undercheckedPredicateInventory(parseArgs(process.argv.slice(2)));
}
