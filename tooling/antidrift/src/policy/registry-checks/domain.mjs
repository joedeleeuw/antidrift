import { resolve } from "node:path";
import {
  isRecord,
  stringArray,
  requireExistingPath,
  requireMatchingValueExport,
} from "./registry-contracts.mjs";

function rejectUnknownKeys(record, allowedKeys, label, errors) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${label} has unknown key '${key}'.`);
    }
  }
}

function checkOwnedValuesEntry(entry, label, state) {
  rejectUnknownKeys(
    entry,
    ["owner", "values", "valuesExport"],
    label,
    state.errors
  );
  requireExistingPath(state.root, entry.owner, `${label}.owner`, state.errors);
  const values = stringArray(entry.values, `${label}.values`, state.errors);
  requireMatchingValueExport(
    state.root,
    entry.owner,
    entry.valuesExport,
    values,
    label,
    state.errors
  );
}

function checkStatuses(statuses, state) {
  if (statuses === undefined) return;
  if (!isRecord(statuses)) {
    state.errors.push(
      "policy/registries/domain.yaml statuses must be a mapping."
    );
    return;
  }
  for (const [name, entry] of Object.entries(statuses)) {
    const label = `policy/registries/domain.yaml statuses.${name}`;
    if (!isRecord(entry)) {
      state.errors.push(`${label} must be a mapping.`);
      continue;
    }
    checkOwnedValuesEntry(entry, label, state);
  }
}

function checkRoles(roles, state) {
  if (roles === undefined) return;
  if (!isRecord(roles)) {
    state.errors.push("policy/registries/domain.yaml roles must be a mapping.");
    return;
  }
  checkOwnedValuesEntry(roles, "policy/registries/domain.yaml roles", state);
}

function checkGateways(registry, state) {
  const fileLabel = "policy/registries/gateways.yaml";
  rejectUnknownKeys(registry, ["approvedGateways"], fileLabel, state.errors);
  if (registry.approvedGateways === undefined) return;
  if (!isRecord(registry.approvedGateways)) {
    state.errors.push(`${fileLabel} approvedGateways must be a mapping.`);
    return;
  }
  for (const [name, entry] of Object.entries(registry.approvedGateways)) {
    const label = `${fileLabel} approvedGateways.${name}`;
    if (!isRecord(entry)) {
      state.errors.push(`${label} must be a mapping.`);
      continue;
    }
    rejectUnknownKeys(
      entry,
      ["wrapper", "bannedDirectImports"],
      label,
      state.errors
    );
    requireExistingPath(
      state.root,
      entry.wrapper,
      `${label}.wrapper`,
      state.errors
    );
    stringArray(
      entry.bannedDirectImports,
      `${label}.bannedDirectImports`,
      state.errors
    );
  }
}

function checkGeneratedSource(name, entry, state) {
  const label = `policy/registries/generated.yaml generatedSources.${name}`;
  rejectUnknownKeys(
    entry,
    ["generated", "wrapper", "bannedDirectImports", "message"],
    label,
    state.errors
  );
  if (typeof entry.generated !== "string" || entry.generated.length === 0) {
    state.errors.push(`${label}.generated must be a non-empty string.`);
  } else {
    requireExistingPath(
      state.root,
      entry.generated,
      `${label}.generated`,
      state.errors
    );
  }
  if (entry.wrapper !== undefined) {
    requireExistingPath(
      state.root,
      entry.wrapper,
      `${label}.wrapper`,
      state.errors
    );
  }
  if (entry.bannedDirectImports !== undefined) {
    stringArray(
      entry.bannedDirectImports,
      `${label}.bannedDirectImports`,
      state.errors,
      {
        allowEmpty: true,
      }
    );
  }
}

function checkGenerated(registry, state) {
  const fileLabel = "policy/registries/generated.yaml";
  rejectUnknownKeys(registry, ["generatedSources"], fileLabel, state.errors);
  if (registry.generatedSources === undefined) return;
  if (!isRecord(registry.generatedSources)) {
    state.errors.push(`${fileLabel} generatedSources must be a mapping.`);
    return;
  }
  for (const [name, entry] of Object.entries(registry.generatedSources)) {
    if (!isRecord(entry)) {
      state.errors.push(
        `${fileLabel} generatedSources.${name} must be a mapping.`
      );
      continue;
    }
    checkGeneratedSource(name, entry, state);
  }
}

function checkArchitectureLayer(name, entry, layerNames, errors) {
  const label = `policy/registries/architecture.yaml layers.${name}`;
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  rejectUnknownKeys(entry, ["role", "roots", "mayImport"], label, errors);
  if (
    entry.role !== undefined &&
    entry.role !== "domain" &&
    entry.role !== "boundary"
  ) {
    errors.push(`${label}.role must be "domain" or "boundary".`);
  }
  stringArray(entry.roots, `${label}.roots`, errors);
  for (const target of stringArray(
    entry.mayImport ?? [],
    `${label}.mayImport`,
    errors,
    {
      allowEmpty: true,
    }
  )) {
    if (!layerNames.has(target)) {
      errors.push(`${label}.mayImport references unknown layer: ${target}`);
    }
  }
}

function checkArchitecture(registry, errors) {
  const fileLabel = "policy/registries/architecture.yaml";
  rejectUnknownKeys(registry, ["layers"], fileLabel, errors);
  if (registry.layers === undefined) return;
  if (!isRecord(registry.layers)) {
    errors.push(`${fileLabel} layers must be a mapping.`);
    return;
  }
  const layerNames = new Set(Object.keys(registry.layers));
  for (const [name, entry] of Object.entries(registry.layers)) {
    checkArchitectureLayer(name, entry, layerNames, errors);
  }
}

function checkBoundaries(registry, errors) {
  const fileLabel = "policy/registries/boundaries.yaml";
  rejectUnknownKeys(
    registry,
    ["serverBoundaryGlobs", "requiredCalls"],
    fileLabel,
    errors
  );
  if (registry.serverBoundaryGlobs !== undefined) {
    stringArray(
      registry.serverBoundaryGlobs,
      `${fileLabel} serverBoundaryGlobs`,
      errors
    );
  }
  if (registry.requiredCalls === undefined) return;
  if (!isRecord(registry.requiredCalls)) {
    errors.push(`${fileLabel} requiredCalls must be a mapping.`);
    return;
  }
  rejectUnknownKeys(
    registry.requiredCalls,
    ["authorization"],
    `${fileLabel} requiredCalls`,
    errors
  );
  if (registry.requiredCalls.authorization !== undefined) {
    stringArray(
      registry.requiredCalls.authorization,
      `${fileLabel} requiredCalls.authorization`,
      errors
    );
  }
}

function checkReactNative(registry, state) {
  const fileLabel = "policy/registries/react-native.yaml";
  rejectUnknownKeys(
    registry,
    ["replacementImport", "allowedFiles"],
    fileLabel,
    state.errors
  );
  if (Object.keys(registry).length === 0) return;
  if (
    typeof registry.replacementImport !== "string" ||
    registry.replacementImport.trim().length === 0
  ) {
    state.errors.push(
      `${fileLabel} replacementImport must be a non-empty string.`
    );
  }
  for (const file of stringArray(
    registry.allowedFiles,
    `${fileLabel} allowedFiles`,
    state.errors
  )) {
    requireExistingPath(
      state.root,
      file,
      `${fileLabel} allowedFiles`,
      state.errors
    );
  }
}

export function checkDomainRegistries(registries, repoRoot, errors) {
  const state = { root: resolve(repoRoot), errors: [] };
  checkArchitecture(registries.architecture, state.errors);
  checkBoundaries(registries.boundaries, state.errors);
  rejectUnknownKeys(
    registries.domain,
    ["statuses", "roles"],
    "policy/registries/domain.yaml",
    state.errors
  );
  checkStatuses(registries.domain.statuses, state);
  checkRoles(registries.domain.roles, state);
  checkGateways(registries.gateways, state);
  checkGenerated(registries.generated, state);
  checkReactNative(registries.reactNative ?? {}, state);
  errors.push(...state.errors);
}
