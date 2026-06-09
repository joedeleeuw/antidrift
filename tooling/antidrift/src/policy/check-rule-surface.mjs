import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { defaultCases as chaskiCorpusCases } from "./chaski-corpus.mjs";
import { createConfig } from "../eslint-config/index.mjs";
import plugin from "../eslint-plugin/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, "../../../..");
const blockingDisallowedStatuses = new Set(["under-proven", "false-positive-prone", "research"]);

function severityOf(ruleValue) {
  const severity = Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
  if (severity === "off" || severity === 0) return 0;
  if (severity === "warn" || severity === 1) return 1;
  if (severity === "error" || severity === 2) return 2;
  return 2;
}

function collectConfiguredRuleSettings(configs) {
  const out = new Map();
  for (const config of configs) {
    const rules = config?.rules ?? {};
    for (const [ruleName, ruleValue] of Object.entries(rules)) {
      if (!ruleName.startsWith("antidrift/")) continue;
      const localRuleName = ruleName.slice("antidrift/".length);
      const severity = severityOf(ruleValue);
      const existing = out.get(localRuleName);
      if (!existing || severity > existing.severity) out.set(localRuleName, { ruleValue, severity });
    }
  }
  return out;
}

function readPluginTestSource(repoRoot) {
  const pluginDir = resolve(repoRoot, "tooling/antidrift/src/eslint-plugin");
  try {
    return readdirSync(pluginDir)
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => readFileSync(resolve(pluginDir, file), "utf8"))
      .join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function collectTestedRules(testSource) {
  const out = new Set();
  for (const match of testSource.matchAll(/\b(?:typedRuleTester|ruleTester)\.run\(\s*["']([^"']+)["']/gu)) {
    out.add(match[1]);
  }
  return out;
}

function collectCorpusCoveredRules(cases) {
  const out = new Set();
  for (const testCase of cases ?? []) {
    if (testCase.ruleId?.startsWith("antidrift/")) out.add(testCase.ruleId.slice("antidrift/".length));
  }
  return out;
}

function readRuleRegistry(repoRoot) {
  try {
    return YAML.parse(readFileSync(resolve(repoRoot, "policy/registries/rules.yaml"), "utf8")) ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function registryEntryFor(ruleRegistry, localRuleName) {
  return ruleRegistry?.rules?.[`antidrift/${localRuleName}`] ?? ruleRegistry?.rules?.[localRuleName] ?? null;
}

function isHeuristicSignal(signal) {
  if (typeof signal !== "string") return false;
  const normalized = signal.toLowerCase();
  return normalized.includes("heuristic") || normalized.includes("token-overlap") || normalized.includes("configurable name groups");
}

function collectBlockingMaturityViolations(configuredSettings, ruleRegistry) {
  const out = [];
  for (const [ruleName, setting] of configuredSettings) {
    if (setting.severity === 0) continue;
    const entry = registryEntryFor(ruleRegistry, ruleName);
    if (!entry) continue;
    if (blockingDisallowedStatuses.has(entry.status)) {
      out.push({ ruleName, prefix: `Custom rule configured as blocking despite registry status ${entry.status}` });
    }
    if (isHeuristicSignal(entry.signal)) {
      out.push({ ruleName, prefix: `Custom rule configured as blocking despite heuristic signal ${entry.signal}` });
    }
  }
  return out;
}

function reportSorted(items, prefix, report) {
  for (const item of [...items].sort((a, b) => a.localeCompare(b))) report(`${prefix}: antidrift/${item}`);
}

function reportSortedViolations(items, report) {
  for (const { ruleName, prefix } of [...items].sort((a, b) => `${a.ruleName}:${a.prefix}`.localeCompare(`${b.ruleName}:${b.prefix}`))) {
    report(`${prefix}: antidrift/${ruleName}`);
  }
}

export function checkRuleSurface({
  repoRoot = defaultRepoRoot,
  pluginRules = plugin.rules,
  configs = createConfig({ tsconfigRootDir: repoRoot }),
  testSource,
  corpusCases = chaskiCorpusCases,
  ruleRegistry = readRuleRegistry(repoRoot),
  report = console.error,
} = {}) {
  const resolvedTestSource = testSource ?? readPluginTestSource(repoRoot);
  if (resolvedTestSource === null) {
    report("check-rule-surface skipped: antidrift source layout was not found. This command is intended for the self-hosted antidrift repository.");
    return true;
  }

  const exported = new Set(Object.keys(pluginRules ?? {}));
  const configuredSettings = collectConfiguredRuleSettings(Array.isArray(configs) ? configs : [configs]);
  const configured = new Set(configuredSettings.keys());
  const tested = new Set([...collectTestedRules(resolvedTestSource), ...collectCorpusCoveredRules(corpusCases)]);

  const configuredButNotExported = new Set([...configured].filter((rule) => !exported.has(rule)));
  const exportedButNotConfigured = new Set([...exported].filter((rule) => !configured.has(rule)));
  const exportedButNotTested = new Set([...exported].filter((rule) => !tested.has(rule)));
  const blockingMaturityViolations = collectBlockingMaturityViolations(configuredSettings, ruleRegistry);

  reportSorted(configuredButNotExported, "Custom rule configured but not exported", report);
  reportSorted(exportedButNotConfigured, "Custom rule exported but not configured", report);
  reportSorted(exportedButNotTested, "Custom rule exported but not covered by RuleTester or corpus", report);
  reportSortedViolations(blockingMaturityViolations, report);

  return configuredButNotExported.size + exportedButNotConfigured.size + exportedButNotTested.size + blockingMaturityViolations.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRuleSurface()) {
  process.exitCode = 1;
}
