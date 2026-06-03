import { writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import plugin from "../eslint-plugin/index.js";

const defaultTargets = ["apps", "packages", "tooling"];
const defaultRules = Object.keys(plugin.rules).map((name) => `antidrift/${name}`).sort((a, b) => a.localeCompare(b));
const ignoredPolicy = ["**/fixtures/**", "**/dist/**", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"];
const coreRuleIds = new Set(["no-restricted-imports"]);

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parseArgs(argv) {
  const out = { targets: defaultTargets, rules: defaultRules, slice: "repo-corpus", output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--targets" && next) {
      out.targets = parseCsv(next);
      i += 1;
    } else if (arg === "--rules" && next) {
      out.rules = parseCsv(next).map(normalizeRuleId);
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

function severityOf(ruleValue) {
  const value = Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
  if (value === 2 || value === "error") return "error";
  if (value === 1 || value === "warn") return "warn";
  return "off";
}

function topOf(repoRoot, filePath) {
  return relative(repoRoot, filePath).replace(/\\/gu, "/").split("/")[0] || ".";
}

function emptyRows(rules) {
  return new Map(rules.map((ruleId) => [ruleId, { ruleId, severity: "off", activeFiles: 0, errors: 0, warnings: 0 }]));
}

function markActive(row, severity) {
  if (severity === "off") return;
  row.activeFiles += 1;
  if (row.severity === "off" || row.severity === "warn") row.severity = severity;
}

function markFinding(row, message) {
  if (!row) return;
  if (message.severity === 2) row.errors += 1;
  if (message.severity === 1) row.warnings += 1;
}

async function configsForResults(eslint, results) {
  return Promise.all(results.map(async (result) => ({
    result,
    config: await eslint.calculateConfigForFile(result.filePath),
  })));
}

async function ruleRows(eslint, results, rules) {
  const rows = emptyRows(rules);
  const configuredResults = await configsForResults(eslint, results);

  for (const { result, config } of configuredResults) {
    for (const ruleId of rules) {
      markActive(rows.get(ruleId), severityOf(config?.rules?.[ruleId]));
    }
    for (const message of result.messages) {
      markFinding(rows.get(message.ruleId), message);
    }
  }

  return [...rows.values()];
}

export async function repoCorpus({
  repoRoot = process.cwd(),
  targets = defaultTargets,
  rules = defaultRules,
  slice = "repo-corpus",
  output = null,
  report = console.log,
} = {}) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintFiles(targets);
  const checkedByTop = {};
  for (const result of results) {
    const top = topOf(repoRoot, result.filePath);
    checkedByTop[top] = (checkedByTop[top] ?? 0) + 1;
  }

  const ruleReports = await ruleRows(eslint, results, rules);
  const findings = results.flatMap((result) =>
    result.messages
      .filter((message) => rules.includes(message.ruleId))
      .map((message) => ({
        filePath: relative(repoRoot, result.filePath).replace(/\\/gu, "/"),
        ruleId: message.ruleId,
        severity: message.severity === 2 ? "error" : "warn",
        line: message.line,
        column: message.column,
        message: message.message,
      }))
  );
  const inactiveRules = ruleReports.filter((rule) => rule.activeFiles === 0).map((rule) => rule.ruleId);
  const decision = findings.some((finding) => finding.severity === "error") || inactiveRules.length > 0 ? "fail" : "pass";
  const command = `antidrift repo-corpus --targets ${targets.join(",")} --rules ${rules.join(",")}`;
  const summary = {
    schemaVersion: 1,
    slice,
    command,
    targets,
    checkedFiles: { total: results.length, byTop: checkedByTop },
    ignoredPolicy,
    rules: ruleReports,
    inactiveRules,
    findings,
    decision,
  };
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(repoRoot, output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await repoCorpus(parseArgs(process.argv.slice(2)));
  if (result.decision !== "pass") process.exitCode = 1;
}

export { parseArgs };
