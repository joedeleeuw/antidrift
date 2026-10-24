import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import eslintPlugin from "../../eslint-plugin/index.js";
import oxlintPlugin from "../../oxlint-plugin/index.js";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function requireExistingPath(repoRoot, relativePath, label, errors) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    errors.push(`${label} must be a non-empty relative repo path.`);
    return;
  }
  const root = resolve(repoRoot);
  const target = resolve(root, relativePath);
  if (target === root || !target.startsWith(root + sep)) {
    errors.push(
      `${label} must be a relative repo path below the repository root.`
    );
    return;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${relativePath}`);
  }
}

export function activeAntidriftRules() {
  return new Set(
    [
      ...Object.keys(eslintPlugin.rules),
      ...Object.keys(oxlintPlugin.rules),
    ].map((rule) => `antidrift/${rule}`)
  );
}

function checkRetiredRules(retiredRules, repoRoot, errors) {
  if (retiredRules === undefined) return;
  if (!isRecord(retiredRules)) {
    errors.push("policy/registries/rules.yaml retiredRules must be a mapping.");
    return;
  }
  for (const [rule, entry] of Object.entries(retiredRules)) {
    const label = `policy/registries/rules.yaml retiredRules.${rule}`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be a mapping.`);
      continue;
    }
    if (entry.status !== "retired") {
      errors.push(`${label}.status must be retired.`);
    }
    requireString(entry.reason, `${label}.reason`, errors);
    if (entry.referenceDoc !== undefined) {
      requireExistingPath(
        repoRoot,
        entry.referenceDoc,
        `${label}.referenceDoc`,
        errors
      );
    }
  }
}

export function checkRuleRegistry(registry, repoRoot, errors) {
  if (!isRecord(registry) || Object.keys(registry).length === 0) {
    errors.push(
      "policy/registries/rules.yaml must exist and contain semantic fact or retirement records."
    );
    return;
  }
  if (registry.schemaVersion !== 1) {
    errors.push("policy/registries/rules.yaml schemaVersion must be 1.");
  }
  checkRetiredRules(registry.retiredRules, repoRoot, errors);
}
