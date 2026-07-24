import { join, resolve, sep } from "node:path";
import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { SEMANTIC_FACT_KINDS } from "../lib/semantic-facts.mjs";
import {
  SEMANTIC_ADAPTERS,
  SEMANTIC_ADAPTER_CONTRACTS,
} from "../../semantic-adapters/index.mjs";
import { activeAntidriftRules } from "./rules.mjs";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringArray(value, label, errors, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    errors.push(`${label} must be an array of strings.`);
    return [];
  }
  if (!allowEmpty && value.length === 0) {
    errors.push(`${label} must not be empty.`);
  }
  return value;
}
function safeRepoPath(repoRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }
  const root = resolve(repoRoot);
  const target = resolve(root, relativePath);
  return target === root || target.startsWith(root + sep) ? target : null;
}
function unwrapExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}
function findExportedConst(sourceFile, exportName) {
  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported || !ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== exportName ||
        !declaration.initializer
      ) {
        continue;
      }
      return declaration;
    }
  }
  return null;
}
const allowedSemanticFactCarriers = new Set([
  "semantic-adapter",
  "type-aware-eslint",
  "authority-registry",
  "repo-graph",
  "agent-ops",
  "model-assisted",
  "change-relative",
]);
const allowedSemanticFactConfidences = new Set([
  "deterministic-enforcement",
  "deterministic-inventory",
  "heuristic-inventory",
  "model-suggestion",
]);
const allowedSemanticFactEmissions = new Set([
  "blocking-diagnostic",
  "inventory-only",
  "inventory-proposal",
]);
const allowedActiveRuleProofBuckets = new Set([
  "local-ast-source-shape",
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
]);
const allowedSemanticAdapterProofBuckets = allowedActiveRuleProofBuckets;
const stableProofBucketsRequiringSemanticAdapterClaim = new Set([
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
]);
const allowedSemanticAdapterStatuses = new Set(["inline-pending"]);
function requireString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}
function factKindLiteralsIn(source) {
  return [...source.matchAll(/\bfactKind:\s*["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
}
function addFactKindsFromDirectory(kinds, repoRoot, relativeDir, extension) {
  const directory = safeRepoPath(repoRoot, relativeDir);
  if (!directory || !existsSync(directory)) {
    return;
  }
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(extension) || file.includes(".test.")) {
      continue;
    }
    for (const kind of factKindLiteralsIn(
      readFileSync(join(directory, file), "utf8"),
    )) {
      kinds.add(kind);
    }
  }
}
function emittedSemanticFactKinds(repoRoot) {
  const kinds = new Set();
  const pluginSource = safeRepoPath(
    repoRoot,
    "tooling/antidrift/src/eslint-plugin/index.js",
  );
  if (pluginSource && existsSync(pluginSource)) {
    for (const kind of factKindLiteralsIn(readFileSync(pluginSource, "utf8"))) {
      kinds.add(kind);
    }
  }
  for (const [relativeDir, extension] of [
    ["tooling/antidrift/src/eslint-plugin/rules", ".js"],
    ["tooling/antidrift/src/oxlint-plugin/rules", ".js"],
    ["tooling/antidrift/src/semantic-adapters", ".mjs"],
    ["tooling/antidrift/src/change-scope", ".mjs"],
  ]) {
    addFactKindsFromDirectory(kinds, repoRoot, relativeDir, extension);
  }
  return kinds;
}
function checkAllowedValues(values, allowed, label, errors) {
  for (const value of values) {
    if (!allowed.has(value)) {
      errors.push(
        `${label} contains unsupported value '${value}'. Allowed values: ${[...allowed].join(", ")}.`,
      );
    }
  }
}
function sortedStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}
function equalStringSets(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    sortedStrings(left).join("\0") === sortedStrings(right).join("\0")
  );
}
function checkShippedSemanticFactKindContract(entry, shipped, label, errors) {
  if (!isRecord(entry)) {
    return;
  }
  for (const key of ["adapterId", "carrier", "association", "noSinkBehavior"]) {
    if (entry[key] !== shipped[key]) {
      errors.push(
        `${label}.${key} must match the shipped semantic fact contract (${shipped[key]}).`,
      );
    }
  }
  for (const key of ["rules", "confidence", "emission", "payloadFields"]) {
    if (!equalStringSets(entry[key], shipped[key])) {
      errors.push(
        `${label}.${key} must match the shipped semantic fact contract: ${sortedStrings(shipped[key]).join(", ")}.`,
      );
    }
  }
  if (!equalStringSets(entry.commandIds ?? [], shipped.commandIds ?? [])) {
    errors.push(
      `${label}.commandIds must match the shipped semantic fact contract: ${sortedStrings(shipped.commandIds ?? []).join(", ")}.`,
    );
  }
}
function checkSemanticFactKindEntry(entry, label, activeRules, errors) {
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  const rules = stringArray(entry.rules, `${label}.rules`, errors, {
    allowEmpty: true,
  });
  for (const rule of rules) {
    if (!activeRules.has(rule)) {
      errors.push(`${label}.rules references unknown active rule: ${rule}`);
    }
  }
  const commandIds =
    entry.commandIds === undefined
      ? []
      : stringArray(entry.commandIds, `${label}.commandIds`, errors);
  if (rules.length === 0 && commandIds.length === 0) {
    errors.push(
      `${label} must declare at least one rule or commandId (command-owned facts require commandIds).`,
    );
  }
  requireString(entry.adapterId, `${label}.adapterId`, errors);
  requireString(entry.carrier, `${label}.carrier`, errors);
  if (
    typeof entry.carrier === "string" &&
    !allowedSemanticFactCarriers.has(entry.carrier)
  ) {
    errors.push(
      `${label}.carrier must be one of: ${[...allowedSemanticFactCarriers].join(", ")}.`,
    );
  }
  const confidence = stringArray(
    entry.confidence,
    `${label}.confidence`,
    errors,
  );
  checkAllowedValues(
    confidence,
    allowedSemanticFactConfidences,
    `${label}.confidence`,
    errors,
  );
  const emission = stringArray(entry.emission, `${label}.emission`, errors);
  checkAllowedValues(
    emission,
    allowedSemanticFactEmissions,
    `${label}.emission`,
    errors,
  );
  if (
    entry.carrier === "model-assisted" &&
    emission.includes("blocking-diagnostic")
  ) {
    errors.push(
      `${label}.emission must not include blocking-diagnostic when carrier is model-assisted.`,
    );
  }
  requireString(entry.association, `${label}.association`, errors);
  requireString(entry.noSinkBehavior, `${label}.noSinkBehavior`, errors);
  stringArray(entry.payloadFields, `${label}.payloadFields`, errors);
}
function requireSemanticFactKindsSection(registry, emitted, errors) {
  if (registry.semanticFactKinds === undefined) {
    const shipped = sortedStrings(Object.keys(SEMANTIC_FACT_KINDS));
    if (emitted.size > 0) {
      const emittedKinds = sortedStrings(emitted);
      errors.push(
        `policy/registries/rules.yaml semanticFactKinds is required because the plugin emits semantic facts: ${emittedKinds.join(", ")}`,
      );
    } else if (shipped.length > 0) {
      errors.push(
        `policy/registries/rules.yaml semanticFactKinds is required because the package ships semantic fact contracts: ${shipped.join(", ")}`,
      );
    }
    return false;
  }
  if (!isRecord(registry.semanticFactKinds)) {
    errors.push(
      "policy/registries/rules.yaml semanticFactKinds must be a mapping.",
    );
    return false;
  }
  return true;
}
function checkEmittedSemanticFactKindCoverage(entries, emitted, errors) {
  for (const factKind of sortedStrings(emitted)) {
    if (entries[factKind] === undefined) {
      errors.push(
        `policy/registries/rules.yaml semanticFactKinds missing emitted fact kind: ${factKind}`,
      );
    }
  }
  if (emitted.size > 0) {
    for (const factKind of sortedStrings(Object.keys(entries))) {
      if (!emitted.has(factKind)) {
        errors.push(
          `policy/registries/rules.yaml semanticFactKinds contains non-emitted fact kind: ${factKind}`,
        );
      }
    }
  }
}
function checkSemanticFactKindEntries(entries, activeRules, errors) {
  for (const [factKind, entry] of Object.entries(entries)) {
    checkSemanticFactKindEntry(
      entry,
      `policy/registries/rules.yaml semanticFactKinds.${factKind}`,
      activeRules,
      errors,
    );
  }
}
function checkShippedSemanticFactKindCoverage(entries, errors) {
  for (const factKind of sortedStrings(Object.keys(SEMANTIC_FACT_KINDS))) {
    if (entries[factKind] === undefined) {
      errors.push(
        `policy/registries/rules.yaml semanticFactKinds missing shipped semantic fact contract: ${factKind}`,
      );
      continue;
    }
    checkShippedSemanticFactKindContract(
      entries[factKind],
      SEMANTIC_FACT_KINDS[factKind],
      `policy/registries/rules.yaml semanticFactKinds.${factKind}`,
      errors,
    );
  }
  for (const factKind of sortedStrings(Object.keys(entries))) {
    if (SEMANTIC_FACT_KINDS[factKind] === undefined) {
      errors.push(
        `policy/registries/rules.yaml semanticFactKinds contains non-shipped semantic fact contract: ${factKind}`,
      );
    }
  }
}
function checkUniqueSemanticAdapterContractValue(
  seen,
  value,
  valueLabel,
  key,
  errors,
) {
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  const previous = seen.get(value);
  if (previous !== undefined) {
    errors.push(
      `${valueLabel} duplicates ${previous}; semantic adapter contracts must be unique.`,
    );
    return;
  }
  seen.set(value, key);
}
function checkSemanticAdapterContractMembership(
  contractKeys,
  adapterKeys,
  errors,
  label,
) {
  for (const key of sortedStrings(adapterKeys)) {
    if (!contractKeys.has(key)) {
      errors.push(`${label} missing contract for shipped adapter: ${key}`);
    }
  }
  for (const key of sortedStrings(contractKeys)) {
    if (!adapterKeys.has(key)) {
      errors.push(
        `${label} contains contract for non-exported adapter: ${key}`,
      );
    }
  }
}
function checkSemanticAdapterExports(adapters, errors, label) {
  for (const key of sortedStrings(Object.keys(adapters))) {
    if (!isRecord(adapters[key])) {
      errors.push(`${label}.${key} exported adapter must be a mapping.`);
      continue;
    }
    if (Object.keys(adapters[key]).length === 0) {
      errors.push(
        `${label}.${key} exported adapter must expose at least one runtime primitive.`,
      );
    }
  }
}
function checkSemanticAdapterContractSubpath(contract, contractLabel, errors) {
  if (
    typeof contract.id !== "string" ||
    contract.id.length === 0 ||
    typeof contract.subpath !== "string" ||
    contract.subpath.length === 0
  ) {
    return;
  }
  const expectedSubpath = `@joedeleeuw/antidrift/semantic-adapters/${contract.id}`;
  if (contract.subpath !== expectedSubpath) {
    errors.push(
      `${contractLabel}.subpath must match its id (${expectedSubpath}).`,
    );
  }
}
function checkSemanticAdapterContractRules(
  rules,
  activeRules,
  contractLabel,
  errors,
) {
  for (const rule of rules) {
    if (!activeRules.has(rule)) {
      errors.push(
        `${contractLabel}.rules references unknown active rule: ${rule}`,
      );
    }
  }
}
function checkSemanticAdapterStableRuleProofBuckets(
  rules,
  proofBuckets,
  ruleEntries,
  contractLabel,
  errors,
) {
  for (const rule of rules) {
    const entry = ruleEntries?.[rule];
    if (entry?.stable !== true || !isRecord(entry.promotion)) {
      continue;
    }
    const proofBucket = entry.promotion.proofBucket;
    if (typeof proofBucket !== "string" || proofBucket.length === 0) {
      continue;
    }
    if (!proofBuckets.includes(proofBucket)) {
      errors.push(
        `${contractLabel}.proofBuckets must include stable rule ${rule} promotion proofBucket (${proofBucket}).`,
      );
    }
  }
}
function checkSemanticAdapterStableRuleAssociations(
  rules,
  associations,
  ruleEntries,
  contractLabel,
  errors,
) {
  for (const rule of rules) {
    const entry = ruleEntries?.[rule];
    if (entry?.stable !== true || !isRecord(entry.promotion)) {
      continue;
    }
    const { association, proofBucket } = entry.promotion;
    if (
      !stableProofBucketsRequiringSemanticAdapterClaim.has(proofBucket) ||
      typeof association !== "string" ||
      association.length === 0
    ) {
      continue;
    }
    if (!associations.includes(association)) {
      errors.push(
        `${contractLabel}.associations must include stable rule ${rule} promotion association.`,
      );
    }
  }
}
function claimedSemanticAdapterRules(contracts) {
  const rules = new Set();
  for (const contract of Object.values(contracts)) {
    if (!isRecord(contract) || !Array.isArray(contract.rules)) {
      continue;
    }
    for (const rule of contract.rules) {
      if (typeof rule === "string" && rule.length > 0) {
        rules.add(rule);
      }
    }
  }
  return rules;
}
function checkStableSemanticAdapterRuleClaims(
  contracts,
  ruleEntries,
  label,
  errors,
) {
  if (!isRecord(ruleEntries)) {
    return;
  }
  const claimedRules = claimedSemanticAdapterRules(contracts);
  for (const rule of sortedStrings(Object.keys(ruleEntries))) {
    const entry = ruleEntries[rule];
    if (entry?.stable !== true || !isRecord(entry.promotion)) {
      continue;
    }
    const { proofBucket } = entry.promotion;
    if (!stableProofBucketsRequiringSemanticAdapterClaim.has(proofBucket)) {
      continue;
    }
    if (!claimedRules.has(rule)) {
      errors.push(`${label} must claim stable ${proofBucket} rule ${rule}.`);
    }
  }
}
function ruleEntryProofBuckets(entry) {
  const buckets = [];
  if (Array.isArray(entry?.proofBuckets)) {
    for (const bucket of entry.proofBuckets) {
      if (typeof bucket === "string" && bucket.length > 0) {
        buckets.push(bucket);
      }
    }
  }
  if (
    isRecord(entry?.promotion) &&
    typeof entry.promotion.proofBucket === "string" &&
    entry.promotion.proofBucket.length > 0
  ) {
    buckets.push(entry.promotion.proofBucket);
  }
  return buckets;
}
function checkRuleSemanticAdapterStatus(status, label, errors, { required }) {
  if (status === undefined) {
    if (required) {
      errors.push(
        `${label}.semanticAdapterStatus is required when non-local proof buckets are not claimed by a shipped semantic adapter.`,
      );
    }
    return;
  }
  if (!isRecord(status)) {
    errors.push(`${label}.semanticAdapterStatus must be a mapping.`);
    return;
  }
  if (!allowedSemanticAdapterStatuses.has(status.status)) {
    errors.push(
      `${label}.semanticAdapterStatus.status must be one of: ${[...allowedSemanticAdapterStatuses].join(", ")}.`,
    );
  }
  requireString(status.reason, `${label}.semanticAdapterStatus.reason`, errors);
}
function checkUnclaimedNonStableSemanticAdapterStatuses(
  ruleEntries,
  contracts,
  errors,
) {
  if (!isRecord(ruleEntries)) {
    return;
  }
  const claimedRules = claimedSemanticAdapterRules(contracts);
  for (const rule of sortedStrings(Object.keys(ruleEntries))) {
    const entry = ruleEntries[rule];
    if (!isRecord(entry) || entry.stable !== false) {
      continue;
    }
    const hasNonLocalBucket = ruleEntryProofBuckets(entry).some((bucket) =>
      stableProofBucketsRequiringSemanticAdapterClaim.has(bucket),
    );
    const required = hasNonLocalBucket && !claimedRules.has(rule);
    if (!required && entry.semanticAdapterStatus === undefined) {
      continue;
    }
    checkRuleSemanticAdapterStatus(
      entry.semanticAdapterStatus,
      `policy/registries/rules.yaml rules.${rule}`,
      errors,
      { required },
    );
  }
}
function semanticFactRulesMatchAdapter(factContract, rules) {
  if (!isRecord(factContract)) {
    return false;
  }
  const factRules = Array.isArray(factContract.rules) ? factContract.rules : [];
  return (
    factRules.length > 0 &&
    factRules.every((rule) => typeof rule === "string" && rules.includes(rule))
  );
}
function checkSemanticAdapterFactAdapterIdClaims(
  rules,
  semanticFactAdapterIds,
  semanticFactKinds,
  contractLabel,
  errors,
) {
  if (
    !isRecord(semanticFactKinds) ||
    Object.keys(semanticFactKinds).length === 0
  ) {
    return;
  }
  for (const [factKind, factContract] of Object.entries(semanticFactKinds)) {
    if (!semanticFactRulesMatchAdapter(factContract, rules)) {
      continue;
    }
    const { adapterId } = factContract;
    if (typeof adapterId !== "string" || adapterId.length === 0) {
      continue;
    }
    if (!semanticFactAdapterIds.includes(adapterId)) {
      errors.push(
        `${contractLabel}.semanticFactAdapterIds must include shipped semantic fact ${factKind} adapterId (${adapterId}).`,
      );
    }
  }
}
function checkSemanticAdapterClaimedFactAdapterIds(
  rules,
  semanticFactAdapterIds,
  semanticFactKinds,
  contractLabel,
  errors,
) {
  if (
    !isRecord(semanticFactKinds) ||
    Object.keys(semanticFactKinds).length === 0
  ) {
    return;
  }
  for (const adapterId of semanticFactAdapterIds) {
    const matchingFact = Object.values(semanticFactKinds).find(
      (factContract) =>
        isRecord(factContract) &&
        factContract.adapterId === adapterId &&
        semanticFactRulesMatchAdapter(factContract, rules),
    );
    if (matchingFact === undefined) {
      errors.push(
        `${contractLabel}.semanticFactAdapterIds contains unclaimed shipped semantic fact adapterId: ${adapterId}`,
      );
    }
  }
}
function checkSemanticAdapterFactKindClaims(
  rules,
  semanticFactAdapterIds,
  semanticFactKindNames,
  semanticFactKinds,
  contractLabel,
  errors,
) {
  if (
    !isRecord(semanticFactKinds) ||
    Object.keys(semanticFactKinds).length === 0
  ) {
    return;
  }
  for (const [factKind, factContract] of Object.entries(semanticFactKinds)) {
    if (!semanticFactRulesMatchAdapter(factContract, rules)) {
      continue;
    }
    if (!semanticFactAdapterIds.includes(factContract.adapterId)) {
      continue;
    }
    if (!semanticFactKindNames.includes(factKind)) {
      errors.push(
        `${contractLabel}.semanticFactKinds must include shipped semantic fact kind: ${factKind}.`,
      );
    }
  }
}
function checkSemanticAdapterClaimedFactKinds(
  rules,
  semanticFactAdapterIds,
  semanticFactKindNames,
  semanticFactKinds,
  contractLabel,
  errors,
) {
  if (
    !isRecord(semanticFactKinds) ||
    Object.keys(semanticFactKinds).length === 0
  ) {
    return;
  }
  for (const factKind of semanticFactKindNames) {
    const factContract = semanticFactKinds[factKind];
    if (
      !isRecord(factContract) ||
      !semanticFactRulesMatchAdapter(factContract, rules) ||
      !semanticFactAdapterIds.includes(factContract.adapterId)
    ) {
      errors.push(
        `${contractLabel}.semanticFactKinds contains unclaimed shipped semantic fact kind: ${factKind}`,
      );
    }
  }
}
function checkSemanticAdapterContractEntry(key, contract, context) {
  const {
    activeRules,
    ruleEntries,
    semanticFactKinds,
    seenIds,
    seenSemanticFactAdapterIds,
    seenSemanticFactKinds,
    seenSubpaths,
    label,
    errors,
  } = context;
  const contractLabel = `${label}.${key}`;
  if (!isRecord(contract)) {
    errors.push(`${contractLabel} must be a mapping.`);
    return;
  }
  requireString(contract.id, `${contractLabel}.id`, errors);
  requireString(contract.exportName, `${contractLabel}.exportName`, errors);
  requireString(contract.subpath, `${contractLabel}.subpath`, errors);
  requireString(contract.carrier, `${contractLabel}.carrier`, errors);
  if (contract.exportName !== key) {
    errors.push(
      `${contractLabel}.exportName must match its contract key (${key}).`,
    );
  }
  const rules = stringArray(contract.rules, `${contractLabel}.rules`, errors);
  checkSemanticAdapterContractRules(rules, activeRules, contractLabel, errors);
  const proofBuckets = stringArray(
    contract.proofBuckets,
    `${contractLabel}.proofBuckets`,
    errors,
  );
  checkAllowedValues(
    proofBuckets,
    allowedSemanticAdapterProofBuckets,
    `${contractLabel}.proofBuckets`,
    errors,
  );
  const associations = stringArray(
    contract.associations,
    `${contractLabel}.associations`,
    errors,
  );
  checkSemanticAdapterStableRuleProofBuckets(
    rules,
    proofBuckets,
    ruleEntries,
    contractLabel,
    errors,
  );
  checkSemanticAdapterStableRuleAssociations(
    rules,
    associations,
    ruleEntries,
    contractLabel,
    errors,
  );
  const semanticFactAdapterIds = stringArray(
    contract.semanticFactAdapterIds,
    `${contractLabel}.semanticFactAdapterIds`,
    errors,
    { allowEmpty: true },
  );
  checkSemanticAdapterFactAdapterIdClaims(
    rules,
    semanticFactAdapterIds,
    semanticFactKinds,
    contractLabel,
    errors,
  );
  checkSemanticAdapterClaimedFactAdapterIds(
    rules,
    semanticFactAdapterIds,
    semanticFactKinds,
    contractLabel,
    errors,
  );
  const semanticFactKindNames = stringArray(
    contract.semanticFactKinds,
    `${contractLabel}.semanticFactKinds`,
    errors,
    { allowEmpty: true },
  );
  checkSemanticAdapterFactKindClaims(
    rules,
    semanticFactAdapterIds,
    semanticFactKindNames,
    semanticFactKinds,
    contractLabel,
    errors,
  );
  checkSemanticAdapterClaimedFactKinds(
    rules,
    semanticFactAdapterIds,
    semanticFactKindNames,
    semanticFactKinds,
    contractLabel,
    errors,
  );
  checkSemanticAdapterContractSubpath(contract, contractLabel, errors);
  checkUniqueSemanticAdapterContractValue(
    seenIds,
    contract.id,
    `${contractLabel}.id`,
    key,
    errors,
  );
  for (const semanticFactAdapterId of semanticFactAdapterIds) {
    checkUniqueSemanticAdapterContractValue(
      seenSemanticFactAdapterIds,
      semanticFactAdapterId,
      `${contractLabel}.semanticFactAdapterIds`,
      key,
      errors,
    );
  }
  for (const semanticFactKind of semanticFactKindNames) {
    checkUniqueSemanticAdapterContractValue(
      seenSemanticFactKinds,
      semanticFactKind,
      `${contractLabel}.semanticFactKinds`,
      key,
      errors,
    );
  }
  checkUniqueSemanticAdapterContractValue(
    seenSubpaths,
    contract.subpath,
    `${contractLabel}.subpath`,
    key,
    errors,
  );
}
export function checkSemanticAdapterContracts(
  contracts,
  adapters,
  activeRules,
  errors,
  label = "shipped semantic adapter contracts",
  ruleEntries = {},
  semanticFactKinds = {},
) {
  if (!isRecord(contracts)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  if (!isRecord(adapters)) {
    errors.push(`${label} exported adapters must be a mapping.`);
    return;
  }
  const contractKeys = new Set(Object.keys(contracts));
  const adapterKeys = new Set(Object.keys(adapters));
  checkSemanticAdapterContractMembership(
    contractKeys,
    adapterKeys,
    errors,
    label,
  );
  checkSemanticAdapterExports(adapters, errors, label);
  const seenIds = new Map();
  const seenSemanticFactAdapterIds = new Map();
  const seenSemanticFactKinds = new Map();
  const seenSubpaths = new Map();
  const context = {
    activeRules,
    ruleEntries,
    semanticFactKinds,
    seenIds,
    seenSemanticFactAdapterIds,
    seenSemanticFactKinds,
    seenSubpaths,
    label,
    errors,
  };
  for (const key of sortedStrings(contractKeys)) {
    checkSemanticAdapterContractEntry(key, contracts[key], context);
  }
  checkStableSemanticAdapterRuleClaims(contracts, ruleEntries, label, errors);
}
function hasExportModifier(node) {
  return ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node) {
  return ts
    .getModifiers(node)
    ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}
function addBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingNames(element.name, names);
      }
    }
  }
}
function addNamedExportNames(statement, names) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.isTypeOnly ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return;
  }
  for (const element of statement.exportClause.elements) {
    if (!element.isTypeOnly) {
      names.add(element.name.text);
    }
  }
}
function addExportedDeclarationName(statement, names) {
  if (!hasExportModifier(statement)) {
    return;
  }
  if (hasDefaultModifier(statement)) {
    names.add("default");
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      addBindingNames(declaration.name, names);
    }
    return;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    names.add(statement.name.text);
  }
}
function packageExportedValueNames(sourceText, fileName, scriptKind) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      names.add("default");
      continue;
    }
    addNamedExportNames(statement, names);
    addExportedDeclarationName(statement, names);
  }
  return names;
}
function semanticAdapterAggregateSource(repoRoot, relativePath, scriptKind) {
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) {
    return null;
  }
  return ts.createSourceFile(
    relativePath,
    readFileSync(target, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
}
function moduleSpecifierText(statement) {
  if (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier.text;
  }
  return null;
}
function semanticAdapterNamespaceImports(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const specifier = moduleSpecifierText(statement);
    const bindings = statement.importClause?.namedBindings;
    if (
      specifier?.startsWith("./") &&
      specifier.endsWith(".mjs") &&
      bindings &&
      ts.isNamespaceImport(bindings)
    ) {
      names.add(bindings.name.text);
    }
  }
  return names;
}
function objectFreezeArgument(expression) {
  const current = unwrapExpression(expression);
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Object" &&
    current.expression.name.text === "freeze" &&
    current.arguments.length === 1
  ) {
    return unwrapExpression(current.arguments[0]);
  }
  return current;
}
function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}
function objectLiteralPropertyNames(expression) {
  const objectExpression = objectFreezeArgument(expression);
  if (!ts.isObjectLiteralExpression(objectExpression)) {
    return null;
  }
  const names = new Set();
  for (const property of objectExpression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text);
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = propertyNameText(property.name);
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}
function exportedConstObjectKeys(sourceFile, exportName) {
  const declaration = findExportedConst(sourceFile, exportName);
  if (!declaration) {
    return null;
  }
  return objectLiteralPropertyNames(declaration.initializer);
}
function findExportedVariableDeclaration(sourceFile, exportName) {
  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported || !ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === exportName
      ) {
        return declaration;
      }
    }
  }
  return null;
}
function readonlyTypeArgument(typeNode) {
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "Readonly" &&
    typeNode.typeArguments?.length === 1
  ) {
    return typeNode.typeArguments[0];
  }
  return typeNode;
}
function typeLiteralPropertyNames(typeNode) {
  const literal = readonlyTypeArgument(typeNode);
  if (!ts.isTypeLiteralNode(literal)) {
    return null;
  }
  const names = new Set();
  for (const member of literal.members) {
    if (
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.name
    ) {
      const name = propertyNameText(member.name);
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}
function exportedConstTypePropertyNames(sourceFile, exportName) {
  const declaration = findExportedVariableDeclaration(sourceFile, exportName);
  if (!declaration?.type) {
    return null;
  }
  return typeLiteralPropertyNames(declaration.type);
}
function findExportedTypeAlias(sourceFile, typeName) {
  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      isExported &&
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === typeName
    ) {
      return statement;
    }
  }
  return null;
}
function stringLiteralTypeValue(typeNode) {
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
    return typeNode.literal.text;
  }
  return null;
}
function exportedStringUnionValues(sourceFile, typeName) {
  const alias = findExportedTypeAlias(sourceFile, typeName);
  if (!alias) {
    return null;
  }
  const values = new Set();
  if (ts.isUnionTypeNode(alias.type)) {
    for (const typeNode of alias.type.types) {
      const value = stringLiteralTypeValue(typeNode);
      if (value) {
        values.add(value);
      }
    }
    return values;
  }
  const value = stringLiteralTypeValue(alias.type);
  if (value) {
    values.add(value);
  }
  return values;
}
function checkExpectedSemanticAdapterNames(
  actual,
  expected,
  label,
  errors,
  missing,
  unexpected,
) {
  if (!actual) {
    errors.push(`${label} must declare semantic adapter names.`);
    return;
  }
  for (const key of sortedStrings(expected)) {
    if (!actual.has(key)) {
      errors.push(`${label} ${missing}: ${key}`);
    }
  }
  if (!unexpected) {
    return;
  }
  for (const key of sortedStrings(actual)) {
    if (!expected.has(key)) {
      errors.push(`${label} ${unexpected}: ${key}`);
    }
  }
}
function checkSemanticAdapterRuntimeAggregate(contracts, repoRoot, errors) {
  const relativePath = "tooling/antidrift/src/semantic-adapters/index.mjs";
  const source = semanticAdapterAggregateSource(
    repoRoot,
    relativePath,
    ts.ScriptKind.JS,
  );
  if (!source) {
    return;
  }
  const expected = new Set(Object.keys(contracts));
  const namedExports = packageExportedValueNames(
    readFileSync(safeRepoPath(repoRoot, relativePath), "utf8"),
    relativePath,
    ts.ScriptKind.JS,
  );
  checkExpectedSemanticAdapterNames(
    semanticAdapterNamespaceImports(source),
    expected,
    relativePath,
    errors,
    "missing adapter namespace import",
    "imports unclaimed adapter namespace",
  );
  checkExpectedSemanticAdapterNames(
    namedExports,
    expected,
    relativePath,
    errors,
    "missing named adapter export",
    null,
  );
  checkExpectedSemanticAdapterNames(
    exportedConstObjectKeys(source, "SEMANTIC_ADAPTERS"),
    expected,
    `${relativePath} SEMANTIC_ADAPTERS`,
    errors,
    "missing adapter key",
    "contains unclaimed adapter key",
  );
}
function checkSemanticAdapterTypeAggregate(contracts, repoRoot, errors) {
  const relativePath = "tooling/antidrift/src/semantic-adapters/index.d.mts";
  const source = semanticAdapterAggregateSource(
    repoRoot,
    relativePath,
    ts.ScriptKind.TS,
  );
  if (!source) {
    return;
  }
  const expected = new Set(Object.keys(contracts));
  const namedExports = packageExportedValueNames(
    readFileSync(safeRepoPath(repoRoot, relativePath), "utf8"),
    relativePath,
    ts.ScriptKind.TS,
  );
  checkExpectedSemanticAdapterNames(
    semanticAdapterNamespaceImports(source),
    expected,
    relativePath,
    errors,
    "missing adapter namespace import",
    "imports unclaimed adapter namespace",
  );
  checkExpectedSemanticAdapterNames(
    namedExports,
    expected,
    relativePath,
    errors,
    "missing named adapter export",
    null,
  );
  checkExpectedSemanticAdapterNames(
    exportedConstTypePropertyNames(source, "SEMANTIC_ADAPTERS"),
    expected,
    `${relativePath} SEMANTIC_ADAPTERS declaration`,
    errors,
    "missing adapter key",
    "contains unclaimed adapter key",
  );
  checkExpectedSemanticAdapterNames(
    exportedStringUnionValues(source, "SemanticAdapterContractKey"),
    expected,
    `${relativePath} SemanticAdapterContractKey`,
    errors,
    "missing adapter key",
    "contains unclaimed adapter key",
  );
}
function checkSemanticAdapterAggregateSources(contracts, repoRoot, errors) {
  checkSemanticAdapterRuntimeAggregate(contracts, repoRoot, errors);
  checkSemanticAdapterTypeAggregate(contracts, repoRoot, errors);
}
function checkSemanticFactKinds(registry, repoRoot, errors) {
  const emitted = emittedSemanticFactKinds(repoRoot);
  if (!requireSemanticFactKindsSection(registry, emitted, errors)) {
    return;
  }
  const entries = registry.semanticFactKinds;
  checkEmittedSemanticFactKindCoverage(entries, emitted, errors);
  checkSemanticFactKindEntries(entries, activeAntidriftRules(), errors);
  checkShippedSemanticFactKindCoverage(entries, errors);
}
export function checkSemanticContracts(registry, repoRoot, errors) {
  const activeRules = activeAntidriftRules();
  checkSemanticAdapterContracts(
    SEMANTIC_ADAPTER_CONTRACTS,
    SEMANTIC_ADAPTERS,
    activeRules,
    errors,
    "shipped semantic adapter contracts",
    registry.rules,
    SEMANTIC_FACT_KINDS,
  );
  checkUnclaimedNonStableSemanticAdapterStatuses(
    registry.rules,
    SEMANTIC_ADAPTER_CONTRACTS,
    errors,
  );
  checkSemanticAdapterAggregateSources(
    SEMANTIC_ADAPTER_CONTRACTS,
    repoRoot,
    errors,
  );
  checkSemanticFactKinds(registry, repoRoot, errors);
}
