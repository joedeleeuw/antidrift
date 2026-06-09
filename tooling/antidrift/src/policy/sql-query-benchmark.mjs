import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const powersyncSafeIdentifierOptions = {
  safeIdentifierMembers: [
    {
      type: "SourceTable",
      member: "escapedIdentifier",
      evidence:
        "PowerSync SourceTable.escapedIdentifier is the owned table identifier escape API; TypeScript proves the receiver type before this exemption applies.",
    },
  ],
};
const allowedSqlTagNames = new Set(["sql", "sqlQuery", "sqlRun"]);
const sqlPattern = /\b(?:SELECT\b[\s\S]{0,200}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w."`]+\s+SET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
const sqlKeywordPattern = /\b(?:SELECT|FROM|INSERT|INTO|UPDATE|DELETE|DROP|TABLE|WHERE|JOIN|ORDER|GROUP|VALUES|SET)\b/iu;
const sqlSentencePattern = /\b(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO\b|UPDATE\b[\s\S]*?\bSET\b|DELETE\s+FROM\b|DROP\s+TABLE\b)/iu;
const sqlFragmentKeywordPattern = /\b(?:WHERE|AND|OR|FROM|JOIN|ORDER|GROUP|LIMIT|OFFSET|HAVING|SET|VALUES)\b/iu;
const sqlGuardTextPattern = /(?:sql|table|column|identifier|order|sort|direction|namespace)/iu;
const regexTestMethods = new Set(["test"]);
const membershipMethods = new Set(["includes", "has"]);
const quantifierMethods = new Set(["every", "some"]);

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
    ruleOptions: { [customRuleId]: powersyncSafeIdentifierOptions },
    targets: [
      "modules/module-mysql/src/api/MySQLRouteAPIAdapter.ts",
      "modules/module-mysql/src/replication/BinLogStream.ts",
    ],
  },
  {
    repo: "powersync-service",
    label: "module-postgres-sql-corpus",
    repoCandidates: powersyncServiceRepoCandidates,
    tsconfig: "modules/module-postgres/tsconfig.json",
    ruleOptions: { [customRuleId]: powersyncSafeIdentifierOptions },
    targets: [
      "modules/module-postgres/src/replication/WalStream.ts",
      "modules/module-postgres/src/replication/replication-utils.ts",
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
        benchmarkRuleIds.map((ruleId) => [
          ruleId,
          plan.ruleOptions?.[ruleId]
            ? ["error", plan.ruleOptions[ruleId]]
            : "error",
        ]),
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

function pushExample(examples, example, max = 20) {
  if (examples.length < max) examples.push(example);
}

function baseExample(repo, repoRoot, filePath, node, shape, detail = null) {
  return {
    repo,
    path: relative(repoRoot, filePath).replace(/\\/gu, "/"),
    line: node.loc?.start?.line ?? 1,
    shape,
    detail,
  };
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value.type === "string") {
      walkAst(value, visit);
    }
  }
}

function parsedAst(source, filePath) {
  return tsParser.parse(source, {
    ecmaFeatures: { jsx: true },
    ecmaVersion: 2023,
    filePath,
    loc: true,
    range: true,
    sourceType: "module",
  });
}

function templateLiteralText(node) {
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "").join(" ");
}

function staticSqlText(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return templateLiteralText(node);
  return null;
}

function containsSqlKeyword(node) {
  const text = staticSqlText(node);
  return typeof text === "string" && sqlKeywordPattern.test(text);
}

function hasSqlContext(source) {
  return sqlSentencePattern.test(source) || /\bsql\b/iu.test(source);
}

function sourceText(source, node) {
  return Array.isArray(node?.range) ? source.slice(node.range[0], node.range[1]) : "";
}

function sqlGuardDetail(source, node) {
  const text = sourceText(source, node.test).replace(/\s+/gu, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function hasSqlGuardText(source, node) {
  return sqlGuardTextPattern.test(sourceText(source, node.test));
}

function tagName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "ChainExpression") return tagName(node.expression);
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

function callMemberName(node) {
  const callee = node?.callee;
  if (callee?.type !== "MemberExpression") return null;
  if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name;
  if (callee.computed && callee.property?.type === "Literal") return String(callee.property.value);
  return null;
}

function isCallNamed(node, names) {
  return node?.type === "CallExpression" && names.has(callMemberName(node));
}

function statementExits(node) {
  if (!node) return false;
  if (node.type === "ThrowStatement" || node.type === "ReturnStatement") return true;
  if (node.type === "BlockStatement") return statementExits(node.body.at(-1));
  if (node.type === "IfStatement") return statementExits(node.consequent) && statementExits(node.alternate);
  return false;
}

function negativeRegexExitGuard(node) {
  const test = node.test;
  const call = test?.type === "UnaryExpression" && test.operator === "!" ? test.argument : null;
  return Boolean(isCallNamed(call, regexTestMethods) && statementExits(node.consequent));
}

function positiveRegexGuard(node) {
  return isCallNamed(node.test, regexTestMethods);
}

function membershipGuard(node) {
  return isCallNamed(node.test, membershipMethods);
}

function quantifierGuard(node) {
  return isCallNamed(node.test, quantifierMethods);
}

function arrayJoinedText(node) {
  const object = node.callee?.object;
  if (object?.type !== "ArrayExpression") return null;
  const parts = [];
  for (const element of object.elements) {
    const value = staticSqlText(element);
    if (value === null) return null;
    parts.push(value);
  }
  const separator = node.arguments[0] ? staticSqlText(node.arguments[0]) : ",";
  return separator === null ? null : parts.join(separator);
}

function collectSqlBuilderVariables(ast) {
  const variables = new Set();
  walkAst(ast, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    const value = staticSqlText(node.init);
    if (value !== null && sqlSentencePattern.test(value)) variables.add(node.id.name);
  });
  return variables;
}

function isSqlBuilderVariable(node, sqlBuilderVariables) {
  return node?.type === "Identifier" && sqlBuilderVariables.has(node.name);
}

function recordSqlTag({ repo, repoRoot, filePath, inventory, node }) {
  if (node.type !== "TaggedTemplateExpression" || node.quasi?.type !== "TemplateLiteral") return;
  const name = tagName(node.tag);
  if (!name || !sqlKeywordPattern.test(templateLiteralText(node.quasi))) return;
  const allowed = allowedSqlTagNames.has(name);
  inventory.sqlTags.total += 1;
  if (allowed) inventory.sqlTags.allowed += 1;
  else inventory.sqlTags.unclassified += 1;
  pushExample(inventory.sqlTags.examples, baseExample(repo, repoRoot, filePath, node, allowed ? "allowed-sql-tag" : "unclassified-sql-tag", name));
}

function recordSqlGuard({ repo, repoRoot, filePath, inventory, node, source, sqlContext }) {
  if (!sqlContext || node.type !== "IfStatement" || !hasSqlGuardText(source, node)) return;
  const detail = sqlGuardDetail(source, node);
  if (negativeRegexExitGuard(node)) {
    inventory.guardShapes.negativeRegexExit += 1;
    pushExample(inventory.guardShapes.examples, baseExample(repo, repoRoot, filePath, node, "negative-regex-exit", detail));
  } else if (positiveRegexGuard(node)) {
    inventory.guardShapes.positiveRegexBranch += 1;
    pushExample(inventory.guardShapes.examples, baseExample(repo, repoRoot, filePath, node, "positive-regex-branch", detail));
  } else if (membershipGuard(node)) {
    inventory.guardShapes.membershipBranch += 1;
    pushExample(inventory.guardShapes.examples, baseExample(repo, repoRoot, filePath, node, "membership-branch", detail));
  } else if (quantifierGuard(node)) {
    inventory.guardShapes.quantifierBranch += 1;
    pushExample(inventory.guardShapes.examples, baseExample(repo, repoRoot, filePath, node, "quantifier-branch", detail));
  }
}

function recordSqlBuilderAppend({ repo, repoRoot, filePath, inventory, node, sqlBuilderVariables, source }) {
  if (node.type !== "AssignmentExpression" || node.operator !== "+=" || !isSqlBuilderVariable(node.left, sqlBuilderVariables)) return;
  const rightText = staticSqlText(node.right);
  const detail = sourceText(source, node.right).replace(/\s+/gu, " ").trim();
  if (rightText !== null && sqlFragmentKeywordPattern.test(rightText)) {
    inventory.concatRiskShapes.plusEqualsStaticSqlBuilder += 1;
    pushExample(inventory.concatRiskShapes.examples, baseExample(repo, repoRoot, filePath, node, "plus-equals-static-sql-builder", detail), 80);
  } else if (rightText === null) {
    inventory.concatRiskShapes.plusEqualsDynamicSqlBuilder += 1;
    pushExample(inventory.concatRiskShapes.examples, baseExample(repo, repoRoot, filePath, node, "plus-equals-dynamic-sql-builder", detail), 80);
  }
}

function recordConcatCall({ repo, repoRoot, filePath, inventory, node }) {
  if (node.type !== "CallExpression" || callMemberName(node) !== "concat") return;
  if (![node.callee.object, ...node.arguments].some(containsSqlKeyword)) return;
  inventory.concatRiskShapes.concatCallSql += 1;
  pushExample(inventory.concatRiskShapes.examples, baseExample(repo, repoRoot, filePath, node, "concat-call-sql"), 80);
}

function recordArrayJoin({ repo, repoRoot, filePath, inventory, node }) {
  if (node.type !== "CallExpression" || callMemberName(node) !== "join") return;
  const joined = arrayJoinedText(node);
  if (!joined || !sqlSentencePattern.test(joined)) return;
  inventory.concatRiskShapes.arrayJoinSql += 1;
  pushExample(inventory.concatRiskShapes.examples, baseExample(repo, repoRoot, filePath, node, "array-join-sql"), 80);
}

function recordTemplateOutsideMainPattern({ repo, repoRoot, filePath, inventory, node }) {
  if (node.type !== "TemplateLiteral" || node.expressions.length === 0) return;
  const text = templateLiteralText(node);
  if (sqlPattern.test(text) || !sqlSentencePattern.test(text)) return;
  inventory.concatRiskShapes.keywordTemplateOutsideMainPattern += 1;
  pushExample(inventory.concatRiskShapes.examples, baseExample(repo, repoRoot, filePath, node, "keyword-template-outside-main-pattern"), 80);
}

function classifySqlInventoryForFile({ repo, repoRoot, filePath }) {
  const source = readFileSync(filePath, "utf8");
  const ast = parsedAst(source, filePath);
  const inventory = emptyInventory();
  const sqlContext = hasSqlContext(source);
  const sqlBuilderVariables = collectSqlBuilderVariables(ast);

  walkAst(ast, (node) => {
    const base = { repo, repoRoot, filePath, inventory, node };
    recordSqlTag(base);
    recordSqlGuard({ ...base, source, sqlContext });
    recordSqlBuilderAppend({ ...base, sqlBuilderVariables, source });
    recordConcatCall(base);
    recordArrayJoin(base);
    recordTemplateOutsideMainPattern(base);
  });

  return inventory;
}

function emptyInventory() {
  return {
    sqlTags: { total: 0, allowed: 0, unclassified: 0, examples: [] },
    guardShapes: {
      negativeRegexExit: 0,
      positiveRegexBranch: 0,
      membershipBranch: 0,
      quantifierBranch: 0,
      examples: [],
    },
    concatRiskShapes: {
      plusEqualsStaticSqlBuilder: 0,
      plusEqualsDynamicSqlBuilder: 0,
      concatCallSql: 0,
      arrayJoinSql: 0,
      keywordTemplateOutsideMainPattern: 0,
      examples: [],
    },
    parseErrors: [],
  };
}

function mergeInventory(left, right) {
  const out = structuredClone(left);
  out.sqlTags.total += right.sqlTags.total;
  out.sqlTags.allowed += right.sqlTags.allowed;
  out.sqlTags.unclassified += right.sqlTags.unclassified;
  out.guardShapes.negativeRegexExit += right.guardShapes.negativeRegexExit;
  out.guardShapes.positiveRegexBranch += right.guardShapes.positiveRegexBranch;
  out.guardShapes.membershipBranch += right.guardShapes.membershipBranch;
  out.guardShapes.quantifierBranch += right.guardShapes.quantifierBranch;
  out.concatRiskShapes.plusEqualsStaticSqlBuilder += right.concatRiskShapes.plusEqualsStaticSqlBuilder;
  out.concatRiskShapes.plusEqualsDynamicSqlBuilder += right.concatRiskShapes.plusEqualsDynamicSqlBuilder;
  out.concatRiskShapes.concatCallSql += right.concatRiskShapes.concatCallSql;
  out.concatRiskShapes.arrayJoinSql += right.concatRiskShapes.arrayJoinSql;
  out.concatRiskShapes.keywordTemplateOutsideMainPattern += right.concatRiskShapes.keywordTemplateOutsideMainPattern;
  for (const example of right.sqlTags.examples) pushExample(out.sqlTags.examples, example);
  for (const example of right.guardShapes.examples) pushExample(out.guardShapes.examples, example);
  for (const example of right.concatRiskShapes.examples) pushExample(out.concatRiskShapes.examples, example, 80);
  for (const error of right.parseErrors) pushExample(out.parseErrors, error);
  return out;
}

function inventoryForResults(repo, repoRoot, results) {
  let inventory = emptyInventory();
  for (const result of results) {
    try {
      inventory = mergeInventory(inventory, classifySqlInventoryForFile({ repo, repoRoot, filePath: result.filePath }));
    } catch (error) {
      pushExample(inventory.parseErrors, {
        repo,
        path: relative(repoRoot, result.filePath).replace(/\\/gu, "/"),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inventory;
}

async function lintPlan(plan, repoRoot) {
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

  return { results, parserErrors, findings };
}

function findingLocationSet(findings, ruleId) {
  return new Set(
    findings
      .filter((finding) => finding.ruleId === ruleId)
      .map(locationKey),
  );
}

function nonTypeAwareComparison(typeAwareFindings, nonTypeAwareFindings) {
  const typeAwareLocations = findingLocationSet(typeAwareFindings, customRuleId);
  const nonTypeAwareLocations = findingLocationSet(nonTypeAwareFindings, customRuleId);
  return {
    extraWithoutTypeServices: [...nonTypeAwareLocations].filter((location) => !typeAwareLocations.has(location)).sort((a, b) => a.localeCompare(b)),
    missingWithoutTypeServices: [...typeAwareLocations].filter((location) => !nonTypeAwareLocations.has(location)).sort((a, b) => a.localeCompare(b)),
  };
}

async function nonTypeAwareProbe(plan, repoRoot, typeAwareFindings) {
  if (!plan.tsconfig) return null;
  const probePlan = { ...plan, tsconfig: null };
  const { parserErrors, findings } = await lintPlan(probePlan, repoRoot);
  return {
    typeAware: false,
    checkedTargets: plan.targets,
    parserErrors: parserErrors.length,
    findingsByRule: countByRule(findings),
    comparisonWithTypeAware: nonTypeAwareComparison(typeAwareFindings, findings),
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

  const { results, parserErrors, findings } = await lintPlan(plan, repoRoot);
  const coverageInventory = inventoryForResults(plan.repo, repoRoot, results);

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
    coverageInventory,
    nonTypeAwareProbe: await nonTypeAwareProbe(plan, repoRoot, findings),
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
  const coverageInventory = results.reduce(
    (inventory, result) => mergeInventory(inventory, result.coverageInventory ?? emptyInventory()),
    emptyInventory(),
  );
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
    coverageInventory,
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
