import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { createGovernanceOxlintConfig } from "../oxlint-config/index.mjs";
import { checkChanged } from "./check-changed.mjs";
import { checkGenerated } from "./check-generated-policy-artifacts.mjs";
import { AGENT_HOOKS } from "./generate-policy-artifacts.mjs";
import { REGISTRY_FILES } from "./lib/registries.mjs";
import { loadNativeAddon } from "./oxlint.mjs";
import { checkDomainRegistries } from "./registry-checks/domain.mjs";
import { checkPackageSurface } from "./registry-checks/package-surface.mjs";
import {
  isRecord,
  readRegistry,
} from "./registry-checks/registry-contracts.mjs";
import { shellGuardrails } from "./shell-guardrails.mjs";
import { verifySession } from "./verify-session.mjs";

const moduleRequire = createRequire(import.meta.url);
const REGISTERED_REGISTRY_FILES = new Set(Object.values(REGISTRY_FILES));
const OXLINT_CONFIG_FILENAMES = [
  "oxlint.config.mts",
  "oxlint.config.mjs",
  "oxlint.config.ts",
  "oxlint.config.js",
];

const POLICY_DETECTORS = {
  "check-changed": checkChanged,
  "check-generated": checkGenerated,
  "check-registries": checkRegistries,
  "shell-guardrails": shellGuardrails,
  "verify-session": verifySession,
};

function enabledConfigRules(config) {
  const names = new Set();
  for (const [rule, entry] of Object.entries(config?.rules ?? {})) {
    const level = Array.isArray(entry) ? entry[0] : entry;
    if (level !== "off") names.add(rule);
  }
  for (const override of config?.overrides ?? []) {
    for (const [rule, entry] of Object.entries(override?.rules ?? {})) {
      const level = Array.isArray(entry) ? entry[0] : entry;
      if (level !== "off") names.add(rule);
    }
  }
  return names;
}

function repoOxlintConfig(root) {
  for (const filename of OXLINT_CONFIG_FILENAMES) {
    const candidate = join(root, filename);
    if (existsSync(candidate)) {
      const loaded = moduleRequire(candidate);
      return loaded?.default ?? loaded;
    }
  }
  return null;
}

function activeOxlintDetectors(root, resolvedPolicyDir) {
  const detectors = new Set();
  for (const rule of enabledConfigRules(repoOxlintConfig(root))) {
    if (!rule.startsWith("antidrift/")) detectors.add(rule);
  }
  for (const rule of enabledConfigRules(
    createGovernanceOxlintConfig({ repoRoot: root })
  )) {
    if (!rule.startsWith("antidrift/")) detectors.delete(rule);
  }
  for (const rule of enabledConfigRules(
    createGovernanceOxlintConfig({
      repoRoot: root,
      policyDir: resolvedPolicyDir,
    })
  )) {
    if (!rule.startsWith("antidrift/")) detectors.add(rule);
  }
  return detectors;
}

function checkRegistryDirectory(resolvedPolicyDir, errors) {
  const registriesDir = join(resolvedPolicyDir, "registries");
  if (!existsSync(registriesDir)) return;
  for (const entry of readdirSync(registriesDir)) {
    if (!entry.endsWith(".yaml")) continue;
    const name = entry.slice(0, -".yaml".length);
    if (!REGISTERED_REGISTRY_FILES.has(name)) {
      errors.push(
        `policy/registries/${entry} has no registered reader (allowed: ${[...REGISTERED_REGISTRY_FILES].join(", ")}).`
      );
    }
  }
}

function checkClusterRegistry(cluster, resolvedPolicyDir, errors) {
  if (cluster.registry === undefined) return;
  const match = /^policy\/registries\/([^/]+)\.yaml$/u.exec(
    String(cluster.registry)
  );
  if (!match || !REGISTERED_REGISTRY_FILES.has(match[1])) {
    errors.push(
      `policy/agent-guardrails.yaml cluster '${cluster.id}' references unregistered registry '${cluster.registry}'.`
    );
    return;
  }
  if (!existsSync(join(resolvedPolicyDir, "registries", `${match[1]}.yaml`))) {
    errors.push(
      `policy/agent-guardrails.yaml cluster '${cluster.id}' references missing registry '${cluster.registry}'.`
    );
  }
}

function isKnownDetector(detector, antidriftRuleNames, oxlintDetectors) {
  const colon = detector.indexOf(":");
  if (colon <= 0) return false;
  const prefix = detector.slice(0, colon);
  const target = detector.slice(colon + 1);
  if (prefix === "antidrift") {
    return antidriftRuleNames.has(`antidrift/${target}`);
  }
  if (prefix === "oxlint") return oxlintDetectors.has(target);
  if (prefix === "policy") {
    return typeof POLICY_DETECTORS[target] === "function";
  }
  return false;
}

function checkRuleBinding(rule, antidriftRuleNames, oxlintDetectors, errors) {
  const label = `policy/agent-guardrails.yaml rule '${rule.id}'`;
  if (rule.hookEvent !== undefined) {
    if (!Object.hasOwn(AGENT_HOOKS, rule.hookEvent)) {
      errors.push(`${label} has unknown hookEvent '${rule.hookEvent}'.`);
    }
    return;
  }
  if (typeof rule.detector !== "string" || rule.detector.length === 0) {
    errors.push(`${label} must declare a detector or hookEvent.`);
    return;
  }
  if (!isKnownDetector(rule.detector, antidriftRuleNames, oxlintDetectors)) {
    errors.push(`${label} detector '${rule.detector}' is not registered.`);
  }
}

function checkPolicyDetectors(root, resolvedPolicyDir, errors) {
  const policyFile = join(resolvedPolicyDir, "agent-guardrails.yaml");
  if (!existsSync(policyFile)) return;
  let parsed;
  try {
    parsed = YAML.parse(readFileSync(policyFile, "utf8")) ?? {};
  } catch (error) {
    errors.push(
      `policy/agent-guardrails.yaml could not be parsed: ${error.message}`
    );
    return;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.clusters)) {
    errors.push("policy/agent-guardrails.yaml must contain a clusters array.");
    return;
  }
  const antidriftRuleNames = new Set(
    loadNativeAddon(root)
      .antidriftRules()
      .map(({ name }) => name)
  );
  const oxlintDetectors = activeOxlintDetectors(root, resolvedPolicyDir);
  for (const cluster of parsed.clusters) {
    if (!isRecord(cluster)) continue;
    checkClusterRegistry(cluster, resolvedPolicyDir, errors);
    for (const rule of cluster.rules ?? []) {
      if (isRecord(rule)) {
        checkRuleBinding(rule, antidriftRuleNames, oxlintDetectors, errors);
      }
    }
  }
}

export function checkRegistries({
  repoRoot = process.cwd(),
  policyDir = join(repoRoot, "policy"),
  report = console.error,
} = {}) {
  const root = resolve(repoRoot);
  const resolvedPolicyDir = resolve(policyDir);
  const errors = [];
  checkRegistryDirectory(resolvedPolicyDir, errors);
  const registries = Object.fromEntries(
    Object.entries(REGISTRY_FILES).map(([key, file]) => [
      key,
      readRegistry(resolvedPolicyDir, file, errors),
    ])
  );

  checkDomainRegistries(registries, root, errors);
  if (
    errors.length === 0 ||
    !errors.some((e) => e.includes("could not be parsed"))
  ) {
    checkPolicyDetectors(root, resolvedPolicyDir, errors);
  }
  checkPackageSurface(root, errors);

  for (const error of errors) report(error);
  return errors.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRegistries()) {
  process.exitCode = 1;
}
