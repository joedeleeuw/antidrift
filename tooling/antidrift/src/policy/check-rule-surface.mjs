import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "../eslint-config/index.mjs";
import plugin from "../eslint-plugin/index.js";
import { defaultCases as chaskiCorpusCases } from "./chaski-corpus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, "../../../..");

function isEnabled(ruleValue) {
  if (ruleValue === "off" || ruleValue === 0) return false;
  if (Array.isArray(ruleValue)) return ruleValue[0] !== "off" && ruleValue[0] !== 0;
  return true;
}

function collectConfiguredRules(configs) {
  const out = new Set();
  for (const config of configs) {
    const rules = config?.rules ?? {};
    for (const [ruleName, ruleValue] of Object.entries(rules)) {
      if (ruleName.startsWith("antidrift/") && isEnabled(ruleValue)) out.add(ruleName.slice("antidrift/".length));
    }
  }
  return out;
}

function readPluginTestSource(repoRoot) {
  const pluginDir = resolve(repoRoot, "tooling/antidrift/src/eslint-plugin");
  return readdirSync(pluginDir)
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => readFileSync(resolve(pluginDir, file), "utf8"))
    .join("\n");
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

function reportSorted(items, prefix, report) {
  for (const item of [...items].sort((a, b) => a.localeCompare(b))) report(`${prefix}: antidrift/${item}`);
}

export function checkRuleSurface({
  repoRoot = defaultRepoRoot,
  pluginRules = plugin.rules,
  configs = createConfig({ tsconfigRootDir: repoRoot }),
  testSource = readPluginTestSource(repoRoot),
  corpusCases = chaskiCorpusCases,
  report = console.error,
} = {}) {
  const exported = new Set(Object.keys(pluginRules ?? {}));
  const configured = collectConfiguredRules(Array.isArray(configs) ? configs : [configs]);
  const tested = new Set([...collectTestedRules(testSource), ...collectCorpusCoveredRules(corpusCases)]);

  const configuredButNotExported = new Set([...configured].filter((rule) => !exported.has(rule)));
  const exportedButNotConfigured = new Set([...exported].filter((rule) => !configured.has(rule)));
  const exportedButNotTested = new Set([...exported].filter((rule) => !tested.has(rule)));

  reportSorted(configuredButNotExported, "Custom rule configured but not exported", report);
  reportSorted(exportedButNotConfigured, "Custom rule exported but not configured", report);
  reportSorted(exportedButNotTested, "Custom rule exported but not covered by RuleTester or corpus", report);

  return configuredButNotExported.size + exportedButNotConfigured.size + exportedButNotTested.size === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRuleSurface()) {
  process.exitCode = 1;
}
