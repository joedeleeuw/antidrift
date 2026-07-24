import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { defaultCases as chaskiCorpusCases } from "./chaski-corpus.mjs";
import { defaultCases as externalCorpusCases } from "./external-corpus/cases.mjs";
import { createConfig } from "../eslint-config/index.mjs";
import eslintPlugin from "../eslint-plugin/index.js";
import { createGovernanceOxlintConfig } from "../oxlint-config/index.mjs";
import oxlintPlugin from "../oxlint-plugin/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, "../../../..");
const blockingDisallowedStatuses = new Set([
  "false-positive-prone",
  "research",
  "retired",
  "under-proven",
]);
const defaultCorpusCases = [...chaskiCorpusCases, ...externalCorpusCases];

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
      if (!existing || severity > existing.severity) {
        out.set(localRuleName, { ruleValue, severity });
      }
    }
  }
  return out;
}

function collectDuplicateRuntimeOwners(runtimeConfigs) {
  const owners = new Map();
  for (const [runtime, configs] of Object.entries(runtimeConfigs ?? {})) {
    const settings = collectConfiguredRuleSettings(
      Array.isArray(configs) ? configs : [configs],
    );
    for (const [ruleName, setting] of settings) {
      if (setting.severity === 0) continue;
      const existing = owners.get(ruleName) ?? [];
      existing.push(runtime);
      owners.set(ruleName, existing);
    }
  }
  return [...owners]
    .filter(([, runtimes]) => runtimes.length > 1)
    .map(([ruleName, runtimes]) => ({ ruleName, runtimes }));
}

function collectDuplicateRuntimeExports(runtimePluginRules) {
  const owners = new Map();
  for (const [runtime, rules] of Object.entries(runtimePluginRules ?? {})) {
    for (const ruleName of Object.keys(rules ?? {})) {
      const existing = owners.get(ruleName) ?? [];
      existing.push(runtime);
      owners.set(ruleName, existing);
    }
  }
  return [...owners]
    .filter(([, runtimes]) => runtimes.length > 1)
    .map(([ruleName, runtimes]) => ({ ruleName, runtimes }));
}

function collectCorpusCoveredRules(cases) {
  const out = new Set();
  for (const testCase of cases ?? []) {
    if (testCase.ruleId?.startsWith("antidrift/")) {
      out.add(testCase.ruleId.slice("antidrift/".length));
    }
  }
  return out;
}

function readRuleRegistry(repoRoot) {
  return (
    YAML.parse(
      readFileSync(resolve(repoRoot, "policy/registries/rules.yaml"), "utf8"),
    ) ?? {}
  );
}

function registryEntryFor(ruleRegistry, localRuleName) {
  return (
    ruleRegistry?.rules?.[`antidrift/${localRuleName}`] ??
    ruleRegistry?.rules?.[localRuleName] ??
    null
  );
}

function isHeuristicSignal(signal) {
  if (typeof signal !== "string") return false;
  const normalized = signal.toLowerCase();
  return (
    normalized.includes("heuristic") ||
    normalized.includes("token-overlap") ||
    normalized.includes("configurable name groups")
  );
}

function collectBlockingMaturityViolations(configuredSettings, ruleRegistry) {
  const out = [];
  for (const [ruleName, setting] of configuredSettings) {
    if (setting.severity === 0) continue;
    const entry = registryEntryFor(ruleRegistry, ruleName);
    if (!entry) continue;
    if (entry.defaultOff === true) {
      out.push({
        ruleName,
        prefix:
          "Custom rule configured as blocking despite defaultOff metadata",
      });
    }
    if (blockingDisallowedStatuses.has(entry.status)) {
      out.push({
        ruleName,
        prefix: `Custom rule configured as blocking despite registry status ${entry.status}`,
      });
    }
    if (isHeuristicSignal(entry.signal)) {
      out.push({
        ruleName,
        prefix: `Custom rule configured as blocking despite heuristic signal ${entry.signal}`,
      });
    }
  }
  return out;
}

function reportSorted(items, prefix, report) {
  for (const item of [...items].sort((a, b) => a.localeCompare(b))) {
    report(`${prefix}: antidrift/${item}`);
  }
}

function reportSortedViolations(items, report) {
  for (const { ruleName, prefix } of [...items].sort((a, b) =>
    `${a.ruleName}:${a.prefix}`.localeCompare(`${b.ruleName}:${b.prefix}`),
  )) {
    report(`${prefix}: antidrift/${ruleName}`);
  }
}

function reportDuplicateRuntimeOwners(items, report) {
  for (const { ruleName, runtimes } of [...items].sort((left, right) =>
    left.ruleName.localeCompare(right.ruleName),
  )) {
    report(
      `Custom rule enabled by multiple runtimes: antidrift/${ruleName} (${runtimes.sort().join(", ")})`,
    );
  }
}

function reportDuplicateRuntimeExports(items, report) {
  for (const { ruleName, runtimes } of [...items].sort((left, right) =>
    left.ruleName.localeCompare(right.ruleName),
  )) {
    report(
      `Custom rule exported by multiple runtimes: antidrift/${ruleName} (${runtimes.sort().join(", ")})`,
    );
  }
}

export function checkRuleSurface({
  repoRoot = defaultRepoRoot,
  pluginRules = null,
  runtimePluginRules = null,
  configs = null,
  runtimeConfigs = null,
  corpusCases = defaultCorpusCases,
  ruleRegistry = null,
  report = console.error,
} = {}) {
  runtimePluginRules ??= {
    eslint: eslintPlugin.rules,
    oxlint: oxlintPlugin.rules,
  };
  pluginRules ??= Object.assign({}, ...Object.values(runtimePluginRules));
  if (configs === null) {
    const oxlintConfigs = [createGovernanceOxlintConfig({ repoRoot })];
    const eslintConfigs = createConfig({ tsconfigRootDir: repoRoot });
    configs = [...oxlintConfigs, ...eslintConfigs];
    runtimeConfigs ??= {
      eslint: eslintConfigs,
      oxlint: oxlintConfigs,
    };
  }
  ruleRegistry ??= readRuleRegistry(repoRoot);
  const exported = new Set(Object.keys(pluginRules ?? {}));
  const configuredSettings = collectConfiguredRuleSettings(
    Array.isArray(configs) ? configs : [configs],
  );
  const configured = new Set(configuredSettings.keys());
  const corpusCovered = collectCorpusCoveredRules(corpusCases);

  const configuredButNotExported = new Set(
    [...configured].filter((rule) => !exported.has(rule)),
  );
  const exportedButNotConfigured = new Set(
    [...exported].filter((rule) => !configured.has(rule)),
  );
  const exportedButNotCorpusCovered = new Set(
    [...exported].filter((rule) => !corpusCovered.has(rule)),
  );
  const blockingMaturityViolations = collectBlockingMaturityViolations(
    configuredSettings,
    ruleRegistry,
  );
  const duplicateRuntimeOwners = collectDuplicateRuntimeOwners(runtimeConfigs);
  const duplicateRuntimeExports =
    collectDuplicateRuntimeExports(runtimePluginRules);

  reportSorted(
    configuredButNotExported,
    "Custom rule configured but not exported",
    report,
  );
  reportSorted(
    exportedButNotConfigured,
    "Custom rule exported but not configured",
    report,
  );
  reportSorted(
    exportedButNotCorpusCovered,
    "Custom rule exported but not covered by corpus evidence",
    report,
  );
  reportSortedViolations(blockingMaturityViolations, report);
  reportDuplicateRuntimeOwners(duplicateRuntimeOwners, report);
  reportDuplicateRuntimeExports(duplicateRuntimeExports, report);

  return (
    configuredButNotExported.size +
      exportedButNotConfigured.size +
      exportedButNotCorpusCovered.size +
      blockingMaturityViolations.length +
      duplicateRuntimeOwners.length +
      duplicateRuntimeExports.length ===
    0
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRuleSurface()) {
  process.exitCode = 1;
}
