import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateReferenceDoc(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return [`${label} must be a non-empty relative repo path.`];
  }
  const target = resolve(root, relativePath);
  if (target === root || !target.startsWith(root + sep)) {
    return [`${label} must be a relative repo path below the repository root.`];
  }
  if (!existsSync(target)) {
    return [`${label} path does not exist: ${relativePath}`];
  }
  return [];
}

export function checkRuleRegistry(registry, repoRoot, errors) {
  const root = resolve(repoRoot);
  if (!isRecord(registry) || Object.keys(registry).length === 0) {
    errors.push(
      "policy/registries/rules.yaml must exist and contain retirement records."
    );
    return;
  }
  if (registry.schemaVersion !== 1) {
    errors.push("policy/registries/rules.yaml schemaVersion must be 1.");
  }
  const entries = registry.retiredRules;
  if (entries === undefined) return;
  if (!isRecord(entries)) {
    errors.push("policy/registries/rules.yaml retiredRules must be a mapping.");
    return;
  }
  for (const [rule, entry] of Object.entries(entries)) {
    const label = `policy/registries/rules.yaml retiredRules.${rule}`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be a mapping.`);
      continue;
    }
    if (entry.status !== "retired") {
      errors.push(`${label}.status must be retired.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      errors.push(`${label}.reason must be a non-empty string.`);
    }
    if (entry.referenceDoc !== undefined) {
      errors.push(
        ...validateReferenceDoc(
          root,
          entry.referenceDoc,
          `${label}.referenceDoc`
        )
      );
    }
  }
}
