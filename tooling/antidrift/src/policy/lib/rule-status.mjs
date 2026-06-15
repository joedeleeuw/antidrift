import { readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import { SEMANTIC_ADAPTER_MANIFEST } from "../../semantic-adapters/index.mjs";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sortedEntries(record) {
  if (!isRecord(record)) return [];
  return Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function stringArray(value) {
  return Array.isArray(value)
    ? Object.freeze(value.filter((entry) => typeof entry === "string"))
    : Object.freeze([]);
}

function optionalStringFields(entry, fields, target) {
  for (const field of fields) {
    if (typeof entry[field] === "string") target[field] = entry[field];
  }
}

function statusEntry(id, kind, entry) {
  const normalized = {
    id,
    kind,
  };
  if (!isRecord(entry)) return Object.freeze(normalized);
  optionalStringFields(
    entry,
    [
      "antidriftRule",
      "coverage",
      "nextAction",
      "reason",
      "referenceDoc",
      "replacement",
      "signal",
      "solveType",
      "status",
    ],
    normalized,
  );
  if (typeof entry.stable === "boolean") normalized.stable = entry.stable;
  const proofBuckets = stringArray(entry.proofBuckets);
  if (proofBuckets.length > 0) {
    normalized.proofBuckets = proofBuckets;
  }
  const corpusRepositories = stringArray(entry.corpusRepositories);
  if (corpusRepositories.length > 0) {
    normalized.corpusRepositories = corpusRepositories;
  }
  if (entry.external !== undefined) normalized.external = entry.external;
  if (entry.promotion !== undefined) normalized.promotion = entry.promotion;
  if (entry.semanticAdapterStatus !== undefined) {
    normalized.semanticAdapterStatus = entry.semanticAdapterStatus;
  }
  return Object.freeze(normalized);
}

export function loadRuleStatusRegistrySync(policyDir = "policy") {
  try {
    return (
      YAML.parse(
        readFileSync(join(policyDir, "registries", "rules.yaml"), "utf8"),
      ) ?? { schemaVersion: 1 }
    );
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1 };
    throw error;
  }
}

export function ruleStatusEntriesFromRegistry(registry = {}) {
  return Object.freeze([
    ...sortedEntries(registry.rules).map(([id, entry]) =>
      statusEntry(id, "active", entry),
    ),
    ...sortedEntries(registry.retiredRules).map(([id, entry]) =>
      statusEntry(id, "retired", entry),
    ),
    ...sortedEntries(registry.researchCandidates).map(([id, entry]) =>
      statusEntry(id, "research", entry),
    ),
    ...sortedEntries(registry.policyRuleReviews).map(([id, entry]) =>
      statusEntry(id, "policy-review", entry),
    ),
  ]);
}

export function ruleStatusManifest(registry = {}) {
  return Object.freeze({
    schemaVersion:
      Number.isInteger(registry.schemaVersion) && registry.schemaVersion > 0
        ? registry.schemaVersion
        : 1,
    promotionRequirements: registry.promotionRequirements ?? {},
    entries: ruleStatusEntriesFromRegistry(registry),
  });
}

function manifestEntries(manifestOrRegistry) {
  return Array.isArray(manifestOrRegistry?.entries)
    ? manifestOrRegistry.entries
    : ruleStatusEntriesFromRegistry(manifestOrRegistry);
}

export function ruleStatusEntryForId(id, manifestOrRegistry = {}) {
  return (
    manifestEntries(manifestOrRegistry).find((entry) => entry.id === id) ?? null
  );
}

export function ruleStatusEntriesForKind(kind, manifestOrRegistry = {}) {
  return Object.freeze(
    manifestEntries(manifestOrRegistry).filter((entry) => entry.kind === kind),
  );
}

function ruleStatusEntriesForRuleIds(ruleIds, manifestOrRegistry) {
  const ids = new Set(ruleIds);
  return Object.freeze(
    manifestEntries(manifestOrRegistry).filter((entry) => ids.has(entry.id)),
  );
}

export function ruleStatusEntriesForSemanticAdapter(
  adapterId,
  manifestOrRegistry = {},
) {
  const adapter = SEMANTIC_ADAPTER_MANIFEST.find(
    (entry) => entry.id === adapterId,
  );
  return ruleStatusEntriesForRuleIds(adapter?.rules ?? [], manifestOrRegistry);
}

export function ruleStatusEntriesForProofBucket(
  proofBucket,
  manifestOrRegistry = {},
) {
  const adapterRuleIds = SEMANTIC_ADAPTER_MANIFEST.filter((entry) =>
    entry.proofBuckets.includes(proofBucket),
  ).flatMap((entry) => entry.rules);
  const promotionRuleIds = manifestEntries(manifestOrRegistry)
    .filter((entry) => entry.promotion?.proofBucket === proofBucket)
    .map((entry) => entry.id);
  const entryRuleIds = manifestEntries(manifestOrRegistry)
    .filter((entry) => entry.proofBuckets?.includes(proofBucket))
    .map((entry) => entry.id);
  return ruleStatusEntriesForRuleIds(
    [...adapterRuleIds, ...promotionRuleIds, ...entryRuleIds],
    manifestOrRegistry,
  );
}

export function ruleStatusEntriesForStatus(status, manifestOrRegistry = {}) {
  return Object.freeze(
    manifestEntries(manifestOrRegistry).filter(
      (entry) => entry.status === status,
    ),
  );
}

function semanticAdaptersForRuleId(ruleId) {
  return Object.freeze(
    SEMANTIC_ADAPTER_MANIFEST.filter((adapter) =>
      adapter.rules.includes(ruleId),
    ),
  );
}

function semanticFactContractsForAdapters(adapters) {
  const seen = new Set();
  const contracts = [];
  for (const adapter of adapters) {
    for (const contract of adapter.semanticFactContracts ?? []) {
      if (seen.has(contract.factKind)) continue;
      seen.add(contract.factKind);
      contracts.push(contract);
    }
  }
  return Object.freeze(contracts);
}

function proofBucketsForEntry(entry, adapters) {
  const buckets = new Set();
  for (const adapter of adapters) {
    for (const bucket of adapter.proofBuckets) buckets.add(bucket);
  }
  for (const bucket of entry.proofBuckets ?? []) buckets.add(bucket);
  if (typeof entry.promotion?.proofBucket === "string") {
    buckets.add(entry.promotion.proofBucket);
  }
  return Object.freeze([...buckets]);
}

function ruleStatusSemanticSummary(entry) {
  const semanticAdapters = semanticAdaptersForRuleId(entry.id);
  return Object.freeze({
    entry,
    proofBuckets: proofBucketsForEntry(entry, semanticAdapters),
    semanticAdapters,
    semanticFactContracts: semanticFactContractsForAdapters(semanticAdapters),
  });
}

export function ruleStatusSemanticSummaryForId(id, manifestOrRegistry = {}) {
  const entry = ruleStatusEntryForId(id, manifestOrRegistry);
  return entry ? ruleStatusSemanticSummary(entry) : null;
}

export function ruleStatusSemanticSummaries(manifestOrRegistry = {}) {
  return Object.freeze(
    manifestEntries(manifestOrRegistry).map((entry) =>
      ruleStatusSemanticSummary(entry),
    ),
  );
}
