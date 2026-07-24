import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import eslintPlugin from "../../eslint-plugin/index.js";
import oxlintPlugin from "../../oxlint-plugin/index.js";

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
function requireExistingPath(repoRoot, relativePath, label, errors) {
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target) {
    errors.push(`${label} must be a relative repo path.`);
    return;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${relativePath}`);
  }
}
const allowedRuleStatuses = new Set([
  "ready",
  "under-proven",
  "false-positive-prone",
  "ecosystem-covered",
  "retired",
  "research",
]);
const allowedExternalStates = new Set([
  "equivalent",
  "broader-upstream",
  "narrower-upstream",
  "partial-overlap",
  "config-replacement",
  "net-antidrift",
]);
const allowedExternalSupport = new Set(["none", "low", "medium", "high"]);
const allowedExternalDecisions = new Set([
  "use-upstream",
  "use-both",
  "own-antidrift",
  "retired",
]);
const allowedProofBuckets = new Set([
  "local-ast-source-shape",
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
  "repo-session-runtime",
  "diff-relative",
]);
const allowedActiveRuleProofBuckets = new Set([
  "local-ast-source-shape",
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
]);
const commandOwnedProofBuckets = new Set(["diff-relative"]);
const allowedPolicyReviewStatuses = new Set([
  "active-custom",
  "ecosystem-covered",
  "generated-config",
  "policy-script",
  "hook-covered",
  "delegated",
  "spec-only",
  "research",
  "merged",
  "retired",
]);
const policyReviewStatusesRequiringReplacement = new Set([
  "ecosystem-covered",
  "generated-config",
  "policy-script",
  "hook-covered",
  "delegated",
  "retired",
]);
const allowedAgentOpsPolicyReviewStatuses = new Set([
  "hook-covered",
  "policy-script",
  "delegated",
  "spec-only",
  "research",
  "retired",
]);
function requireString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string.`);
  }
}
function requireStablePromotionValue(value, expected, label, errors) {
  if (value !== expected) {
    errors.push(`${label} must be ${String(expected)} for stable promotion.`);
  }
}
function isFixtureEvidencePath(path) {
  return path.split(/[\\/]+/u).includes("fixtures");
}
function checkPromotionEvidenceRefs(
  refs,
  label,
  repoRoot,
  errors,
  { rejectFixtures = false } = {},
) {
  const paths = stringArray(refs, label, errors);
  if (!repoRoot) {
    return;
  }
  for (const path of paths) {
    if (rejectFixtures && isFixtureEvidencePath(path)) {
      errors.push(`${label} entry must not point at fixture evidence: ${path}`);
    }
    requireExistingPath(repoRoot, path, `${label} entry`, errors);
  }
}
function checkRuleExamples(examples, label, errors) {
  if (!isRecord(examples)) {
    errors.push(`${label}.examples must be a mapping.`);
    return;
  }
  stringArray(examples.flags, `${label}.examples.flags`, errors);
  stringArray(examples.allows, `${label}.examples.allows`, errors);
}
function checkRuleExternal(external, label, errors) {
  if (!isRecord(external)) {
    errors.push(`${label}.external must be a mapping.`);
    return;
  }
  if (!allowedExternalStates.has(external.state)) {
    errors.push(
      `${label}.external.state must be one of: ${[...allowedExternalStates].join(", ")}.`,
    );
  }
  if (!allowedExternalSupport.has(external.support)) {
    errors.push(
      `${label}.external.support must be one of: ${[...allowedExternalSupport].join(", ")}.`,
    );
  }
  if (!allowedExternalDecisions.has(external.decision)) {
    errors.push(
      `${label}.external.decision must be one of: ${[...allowedExternalDecisions].join(", ")}.`,
    );
  }
  stringArray(
    external.candidates ?? [],
    `${label}.external.candidates`,
    errors,
    { allowEmpty: true },
  );
  requireString(
    external.whyThisState,
    `${label}.external.whyThisState`,
    errors,
  );
  requireString(
    external.whyNotOtherState,
    `${label}.external.whyNotOtherState`,
    errors,
  );
}
function checkRulePromotion(promotion, label, errors) {
  if (!isRecord(promotion)) {
    errors.push(`${label}.promotion must be a mapping for stable rules.`);
    return;
  }
  if (!allowedProofBuckets.has(promotion.proofBucket)) {
    errors.push(
      `${label}.promotion.proofBucket must be one of: ${[...allowedProofBuckets].join(", ")}.`,
    );
  } else if (!allowedActiveRuleProofBuckets.has(promotion.proofBucket)) {
    errors.push(
      `${label}.promotion.proofBucket contains unsupported active rule proof bucket '${promotion.proofBucket}'. Allowed values: ${[...allowedActiveRuleProofBuckets].join(", ")}.`,
    );
  }
  requireString(
    promotion.association,
    `${label}.promotion.association`,
    errors,
  );
  requireString(
    promotion.blockingThreshold,
    `${label}.promotion.blockingThreshold`,
    errors,
  );
  requireString(
    promotion.ecosystemComparison,
    `${label}.promotion.ecosystemComparison`,
    errors,
  );
  requireString(
    promotion.corpusEvidence,
    `${label}.promotion.corpusEvidence`,
    errors,
  );
  requireString(
    promotion.noSinkBehavior,
    `${label}.promotion.noSinkBehavior`,
    errors,
  );
  requireString(
    promotion.noDeadWorkBehavior,
    `${label}.promotion.noDeadWorkBehavior`,
    errors,
  );
}
function hasNonStableBlocker(entry) {
  return ["concerns", "unproven", "openReviewConcerns"].some((field) =>
    (entry[field] ?? []).some(
      (item) => typeof item === "string" && item.length > 0,
    ),
  );
}
function checkStableRuleEntry(entry, label, errors) {
  checkRulePromotion(entry.promotion, label, errors);
  requireString(entry.referenceDoc, `${label}.referenceDoc`, errors);
  if (entry.external?.decision !== "own-antidrift") {
    errors.push(
      `${label}.external.decision must be own-antidrift for stable active rules.`,
    );
  }
}
function checkNonStableRuleEntry(entry, label, errors) {
  requireString(entry.nextAction, `${label}.nextAction`, errors);
  const proofBuckets = stringArray(
    entry.proofBuckets,
    `${label}.proofBuckets`,
    errors,
  );
  checkAllowedValues(
    proofBuckets,
    allowedActiveRuleProofBuckets,
    `${label}.proofBuckets`,
    errors,
  );
  if (!hasNonStableBlocker(entry)) {
    errors.push(
      `${label} must document at least one non-stable blocker in concerns, unproven, or openReviewConcerns.`,
    );
  }
}
function checkOptionalRuleProofBuckets(entry, label, errors, { active }) {
  if (entry.proofBuckets === undefined || (active && entry.stable === false)) {
    return;
  }
  const proofBuckets = stringArray(
    entry.proofBuckets,
    `${label}.proofBuckets`,
    errors,
  );
  checkAllowedValues(
    proofBuckets,
    active ? allowedActiveRuleProofBuckets : allowedProofBuckets,
    `${label}.proofBuckets`,
    errors,
  );
}
function checkDefaultOffRuleMetadata(entry, label, errors, { active }) {
  if (entry.defaultOff === undefined) {
    return;
  }
  if (typeof entry.defaultOff !== "boolean") {
    errors.push(`${label}.defaultOff must be a boolean.`);
    return;
  }
  if (active && entry.defaultOff && entry.stable === true) {
    errors.push(`${label}.defaultOff must not be true for stable rules.`);
  }
}
function checkRuleEntry(entry, label, errors, { active, repoRoot }) {
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  if (!allowedRuleStatuses.has(entry.status)) {
    errors.push(
      `${label}.status must be one of: ${[...allowedRuleStatuses].join(", ")}.`,
    );
  }
  if (active && typeof entry.stable !== "boolean") {
    errors.push(`${label}.stable must be a boolean.`);
  }
  checkDefaultOffRuleMetadata(entry, label, errors, { active });
  if (active) {
    requireString(entry.signal, `${label}.signal`, errors);
    requireString(entry.solveType, `${label}.solveType`, errors);
    requireString(entry.referenceDoc, `${label}.referenceDoc`, errors);
    stringArray(
      entry.corpusRepositories ?? [],
      `${label}.corpusRepositories`,
      errors,
      { allowEmpty: true },
    );
    stringArray(entry.concerns ?? [], `${label}.concerns`, errors, {
      allowEmpty: true,
    });
    stringArray(entry.proven ?? [], `${label}.proven`, errors, {
      allowEmpty: true,
    });
    stringArray(entry.unproven ?? [], `${label}.unproven`, errors, {
      allowEmpty: true,
    });
    stringArray(
      entry.openReviewConcerns ?? [],
      `${label}.openReviewConcerns`,
      errors,
      { allowEmpty: true },
    );
    checkRuleExternal(entry.external, label, errors);
    checkRuleExamples(entry.examples, label, errors);
    if (entry.stable === true) {
      checkStableRuleEntry(entry, label, errors);
    } else if (entry.stable === false) {
      checkNonStableRuleEntry(entry, label, errors);
    }
  }
  checkOptionalRuleProofBuckets(entry, label, errors, { active });
  if (entry.nextAction !== undefined) {
    requireString(entry.nextAction, `${label}.nextAction`, errors);
  }
  if (entry.referenceDoc !== undefined && repoRoot) {
    requireExistingPath(
      repoRoot,
      entry.referenceDoc,
      `${label}.referenceDoc`,
      errors,
    );
  }
}
function commandOwnedRuleIdsFromSemanticFactKinds(semanticFactKinds) {
  const commandOwned = new Set();
  if (!isRecord(semanticFactKinds)) {
    return commandOwned;
  }
  for (const entry of Object.values(semanticFactKinds)) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      Array.isArray(entry.rules) &&
      entry.rules.length === 0 &&
      Array.isArray(entry.commandIds) &&
      entry.commandIds.some((commandId) => typeof commandId === "string")
    ) {
      for (const commandId of entry.commandIds) {
        if (typeof commandId === "string" && commandId.length > 0) {
          commandOwned.add(`${commandId}-conformance`);
        }
      }
    }
  }
  return commandOwned;
}
function checkStableRuleRequirements(
  entry,
  label,
  stableRequirements,
  repoRoot,
  errors,
) {
  if (entry?.stable !== true || !isRecord(stableRequirements)) {
    return;
  }
  const minimum = stableRequirements.minIndependentRepositories;
  if (!Number.isInteger(minimum)) {
    return;
  }
  const repositories = Array.isArray(entry.corpusRepositories)
    ? entry.corpusRepositories
    : [];
  if (new Set(repositories).size < minimum) {
    errors.push(
      `${label}.corpusRepositories must list at least ${minimum} independent repositories for stable promotion.`,
    );
  }
  if (!isRecord(entry.promotion)) {
    return;
  }
  if (stableRequirements.requireReplicationsNotIntroducedForTest === true) {
    requireStablePromotionValue(
      entry.promotion.replicationsNotIntroducedForTest,
      true,
      `${label}.promotion.replicationsNotIntroducedForTest`,
      errors,
    );
  }
  if (stableRequirements.maxKnownFalsePositives === 0) {
    requireStablePromotionValue(
      entry.promotion.knownFalsePositives,
      0,
      `${label}.promotion.knownFalsePositives`,
      errors,
    );
  }
  if (stableRequirements.maxKnownFalseNegatives === 0) {
    requireStablePromotionValue(
      entry.promotion.knownFalseNegatives,
      0,
      `${label}.promotion.knownFalseNegatives`,
      errors,
    );
  }
  if (stableRequirements.productionConcerns === "none") {
    if (entry.promotion.productionConcerns !== "none") {
      errors.push(
        `${label}.promotion.productionConcerns must be 'none' for stable promotion.`,
      );
    }
  }
  if (stableRequirements.requireClaudeAdvisoryReview === true) {
    requireString(
      entry.promotion.claudeAdvisoryReview,
      `${label}.promotion.claudeAdvisoryReview`,
      errors,
    );
    checkPromotionEvidenceRefs(
      entry.promotion.claudeAdvisoryReviewRefs,
      `${label}.promotion.claudeAdvisoryReviewRefs`,
      repoRoot,
      errors,
    );
  }
  if (stableRequirements.requireRealCorpusInventory === true) {
    requireString(
      entry.promotion.realCorpusInventory,
      `${label}.promotion.realCorpusInventory`,
      errors,
    );
    checkPromotionEvidenceRefs(
      entry.promotion.realCorpusInventoryRefs,
      `${label}.promotion.realCorpusInventoryRefs`,
      repoRoot,
      errors,
      { rejectFixtures: true },
    );
  }
}
export function activeAntidriftRules() {
  return new Set(
    [
      ...Object.keys(eslintPlugin.rules),
      ...Object.keys(oxlintPlugin.rules),
    ].map((rule) => `antidrift/${rule}`),
  );
}
function checkStablePromotionRequirements(stable, errors) {
  if (!isRecord(stable)) {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.stable must be a mapping.",
    );
    return;
  }
  if (
    stable.minIndependentRepositories !== undefined &&
    (!Number.isInteger(stable.minIndependentRepositories) ||
      stable.minIndependentRepositories < 2)
  ) {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.stable.minIndependentRepositories must be an integer >= 2.",
    );
  }
  for (const key of [
    "requireReplicationsNotIntroducedForTest",
    "requireClaudeAdvisoryReview",
    "requireRealCorpusInventory",
  ]) {
    if (typeof stable[key] !== "boolean") {
      errors.push(
        `policy/registries/rules.yaml promotionRequirements.stable.${key} must be a boolean.`,
      );
    }
  }
  if (stable.maxKnownFalsePositives !== 0) {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.stable.maxKnownFalsePositives must be 0.",
    );
  }
  if (stable.maxKnownFalseNegatives !== 0) {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.stable.maxKnownFalseNegatives must be 0.",
    );
  }
  if (stable.productionConcerns !== "none") {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.stable.productionConcerns must be 'none'.",
    );
  }
}
function checkInvestigationRequirements(investigation, errors) {
  if (!isRecord(investigation)) {
    errors.push(
      "policy/registries/rules.yaml promotionRequirements.investigation must be a mapping.",
    );
    return;
  }
  for (const key of [
    "requireReferenceDoc",
    "requireEcosystemCheck",
    "requireClaudeAdvisoryKickoff",
  ]) {
    if (typeof investigation[key] !== "boolean") {
      errors.push(
        `policy/registries/rules.yaml promotionRequirements.investigation.${key} must be a boolean.`,
      );
    }
  }
}
function checkClaudeAdvisory(advisory, repoRoot, errors) {
  if (advisory === undefined) {
    return;
  }
  if (!isRecord(advisory)) {
    errors.push(
      "policy/registries/rules.yaml claudeAdvisory must be a mapping.",
    );
    return;
  }
  if (advisory.model !== "claude-opus-4-8") {
    errors.push(
      "policy/registries/rules.yaml claudeAdvisory.model must be claude-opus-4-8.",
    );
  }
  if (advisory.promptProtocol !== undefined) {
    requireExistingPath(
      repoRoot,
      advisory.promptProtocol,
      "policy/registries/rules.yaml claudeAdvisory.promptProtocol",
      errors,
    );
  }
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
function checkActiveRuleEntries(rules, repoRoot, stableRequirements, errors) {
  if (!isRecord(rules)) {
    errors.push("policy/registries/rules.yaml rules must be a mapping.");
    return;
  }
  const registeredRules = new Set(Object.keys(rules));
  const activeRules = activeAntidriftRules();
  for (const rule of [...activeRules].sort((a, b) => a.localeCompare(b))) {
    if (!registeredRules.has(rule)) {
      errors.push(
        `policy/registries/rules.yaml missing active rule entry: ${rule}`,
      );
    }
  }
  for (const rule of [...registeredRules].sort((a, b) => a.localeCompare(b))) {
    if (!activeRules.has(rule)) {
      errors.push(
        `policy/registries/rules.yaml rules contains non-active rule; use retiredRules or researchCandidates instead: ${rule}`,
      );
    }
    checkRuleEntry(
      rules[rule],
      `policy/registries/rules.yaml rules.${rule}`,
      errors,
      { active: true, repoRoot },
    );
    checkStableRuleRequirements(
      rules[rule],
      `policy/registries/rules.yaml rules.${rule}`,
      stableRequirements,
      repoRoot,
      errors,
    );
  }
}
function checkRetiredRules(retiredRules, repoRoot, errors) {
  if (retiredRules === undefined) {
    return;
  }
  if (!isRecord(retiredRules)) {
    errors.push("policy/registries/rules.yaml retiredRules must be a mapping.");
    return;
  }
  for (const [rule, entry] of Object.entries(retiredRules)) {
    checkRuleEntry(
      entry,
      `policy/registries/rules.yaml retiredRules.${rule}`,
      errors,
      { active: false, repoRoot },
    );
    if (entry.status !== "retired") {
      errors.push(
        `policy/registries/rules.yaml retiredRules.${rule}.status must be retired.`,
      );
    }
    requireString(
      entry.reason,
      `policy/registries/rules.yaml retiredRules.${rule}.reason`,
      errors,
    );
  }
}
function checkResearchCandidates(
  researchCandidates,
  repoRoot,
  commandOwnedRuleIds,
  errors,
) {
  if (researchCandidates === undefined) {
    return;
  }
  if (!isRecord(researchCandidates)) {
    errors.push(
      "policy/registries/rules.yaml researchCandidates must be a mapping.",
    );
    return;
  }
  for (const [rule, entry] of Object.entries(researchCandidates)) {
    checkRuleEntry(
      entry,
      `policy/registries/rules.yaml researchCandidates.${rule}`,
      errors,
      { active: false, repoRoot },
    );
    if (entry.status !== "research" && entry.status !== "ecosystem-covered") {
      errors.push(
        `policy/registries/rules.yaml researchCandidates.${rule}.status must be research or ecosystem-covered.`,
      );
    }
    requireString(
      entry.signal,
      `policy/registries/rules.yaml researchCandidates.${rule}.signal`,
      errors,
    );
    requireString(
      entry.solveType,
      `policy/registries/rules.yaml researchCandidates.${rule}.solveType`,
      errors,
    );
    if (entry.referenceDoc === undefined) {
      errors.push(
        `policy/registries/rules.yaml researchCandidates.${rule}.referenceDoc is required.`,
      );
    }
    for (const proofBucket of ruleEntryProofBuckets(entry)) {
      if (
        commandOwnedProofBuckets.has(proofBucket) &&
        !commandOwnedRuleIds.has(rule)
      ) {
        errors.push(
          `policy/registries/rules.yaml researchCandidates.${rule}.proofBuckets contains command-owned proof bucket '${proofBucket}' but no command-owned semantic fact maps to ${rule}.`,
        );
      }
    }
  }
}
function knownRuleIds(registry) {
  return new Set([
    ...Object.keys(registry.rules ?? {}),
    ...Object.keys(registry.retiredRules ?? {}),
    ...Object.keys(registry.researchCandidates ?? {}),
  ]);
}
function checkKnownRuleReferences(rules, knownRules, label, errors) {
  for (const rule of rules) {
    if (!knownRules.has(rule)) {
      errors.push(`${label}.rules references unknown rule: ${rule}`);
    }
  }
}
function checkRuleFamilySubset(subsetEntry, subsetLabel, knownRules, errors) {
  if (!isRecord(subsetEntry)) {
    errors.push(`${subsetLabel} must be a mapping.`);
    return;
  }
  requireString(subsetEntry.intent, `${subsetLabel}.intent`, errors);
  const rules = stringArray(subsetEntry.rules, `${subsetLabel}.rules`, errors);
  checkKnownRuleReferences(rules, knownRules, subsetLabel, errors);
  stringArray(subsetEntry.flags, `${subsetLabel}.flags`, errors);
  stringArray(subsetEntry.allows, `${subsetLabel}.allows`, errors);
}
function checkRuleFamilyEntry(entry, label, repoRoot, knownRules, errors) {
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  requireString(entry.description, `${label}.description`, errors);
  if (entry.referenceDoc !== undefined) {
    requireExistingPath(
      repoRoot,
      entry.referenceDoc,
      `${label}.referenceDoc`,
      errors,
    );
  }
  if (!isRecord(entry.subsets)) {
    errors.push(`${label}.subsets must be a mapping.`);
    return;
  }
  for (const [subset, subsetEntry] of Object.entries(entry.subsets)) {
    checkRuleFamilySubset(
      subsetEntry,
      `${label}.subsets.${subset}`,
      knownRules,
      errors,
    );
  }
}
function checkRuleFamilies(ruleFamilies, registry, repoRoot, errors) {
  if (ruleFamilies === undefined) {
    return;
  }
  if (!isRecord(ruleFamilies)) {
    errors.push("policy/registries/rules.yaml ruleFamilies must be a mapping.");
    return;
  }
  const knownRules = knownRuleIds(registry);
  for (const [family, entry] of Object.entries(ruleFamilies)) {
    checkRuleFamilyEntry(
      entry,
      `policy/registries/rules.yaml ruleFamilies.${family}`,
      repoRoot,
      knownRules,
      errors,
    );
  }
}
function policyClusterRules(cluster, clusterLabel, errors) {
  if (!isRecord(cluster)) {
    errors.push(`${clusterLabel} must be a mapping.`);
    return null;
  }
  if (!Array.isArray(cluster.rules)) {
    errors.push(`${clusterLabel}.rules must be an array.`);
    return null;
  }
  return cluster.rules;
}
function policyRuleId(rule, ruleLabel, errors) {
  if (!isRecord(rule)) {
    errors.push(`${ruleLabel} must be a mapping.`);
    return null;
  }
  if (typeof rule.id !== "string" || rule.id.length === 0) {
    errors.push(`${ruleLabel}.id must be a non-empty string.`);
    return null;
  }
  return rule.id;
}
function addUniquePolicyRuleId(ids, seen, id, errors) {
  if (seen.has(id)) {
    errors.push(`policy/agent-guardrails.yaml duplicate rule id: ${id}`);
    return;
  }
  seen.add(id);
  ids.push(id);
}
function collectPolicyClusterRuleIds(cluster, clusterIndex, ids, seen, errors) {
  const clusterLabel = `policy/agent-guardrails.yaml clusters[${clusterIndex}]`;
  const rules = policyClusterRules(cluster, clusterLabel, errors);
  if (!rules) {
    return;
  }
  for (const [ruleIndex, rule] of rules.entries()) {
    const ruleLabel = `${clusterLabel}.rules[${ruleIndex}]`;
    const id = policyRuleId(rule, ruleLabel, errors);
    if (id) {
      addUniquePolicyRuleId(ids, seen, id, errors);
    }
  }
}
function policyClusters(policySource, errors) {
  if (policySource === null) {
    return null;
  }
  if (Array.isArray(policySource.clusters)) {
    return policySource.clusters;
  }
  errors.push("policy/agent-guardrails.yaml clusters must be an array.");
  return null;
}
function collectPolicyRuleIds(policySource, errors) {
  const clusters = policyClusters(policySource, errors);
  if (!clusters) {
    return [];
  }
  const ids = [];
  const seen = new Set();
  for (const [clusterIndex, cluster] of clusters.entries()) {
    collectPolicyClusterRuleIds(cluster, clusterIndex, ids, seen, errors);
  }
  return ids.sort((a, b) => a.localeCompare(b));
}
function checkPolicyRuleReviewEntry(entry, label, activeRules, errors) {
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  if (!allowedPolicyReviewStatuses.has(entry.status)) {
    errors.push(
      `${label}.status must be one of: ${[...allowedPolicyReviewStatuses].join(", ")}.`,
    );
  }
  if (
    label.includes("policyRuleReviews.agent/") &&
    !allowedAgentOpsPolicyReviewStatuses.has(entry.status)
  ) {
    errors.push(
      `${label}.status must be hook-covered, policy-script, delegated, spec-only, research, or retired for agent-ops policy rules.`,
    );
  }
  requireString(entry.coverage, `${label}.coverage`, errors);
  requireString(entry.reason, `${label}.reason`, errors);
  requireString(entry.nextAction, `${label}.nextAction`, errors);
  if (entry.antidriftRule !== undefined) {
    requireString(entry.antidriftRule, `${label}.antidriftRule`, errors);
    if (!activeRules.has(entry.antidriftRule)) {
      errors.push(
        `${label}.antidriftRule references unknown active custom rule: ${entry.antidriftRule}`,
      );
    }
  }
  if (entry.mergedInto !== undefined) {
    requireString(entry.mergedInto, `${label}.mergedInto`, errors);
  }
  if (entry.replacement !== undefined) {
    requireString(entry.replacement, `${label}.replacement`, errors);
  }
  if (entry.status === "active-custom" && entry.antidriftRule === undefined) {
    errors.push(`${label}.antidriftRule is required for active-custom.`);
  }
  if (entry.status === "merged" && entry.mergedInto === undefined) {
    errors.push(`${label}.mergedInto is required for merged.`);
  }
  if (
    policyReviewStatusesRequiringReplacement.has(entry.status) &&
    entry.replacement === undefined
  ) {
    errors.push(`${label}.replacement is required for ${entry.status}.`);
  }
}
function checkPolicyRuleReviews(registry, policySource, errors) {
  const policyRuleIds = collectPolicyRuleIds(policySource, errors);
  if (policyRuleIds.length === 0) {
    return;
  }
  if (!isRecord(registry.policyRuleReviews)) {
    errors.push(
      "policy/registries/rules.yaml policyRuleReviews must be a mapping.",
    );
    return;
  }
  const reviews = registry.policyRuleReviews;
  const policyRuleSet = new Set(policyRuleIds);
  const activeRules = activeAntidriftRules();
  for (const id of policyRuleIds) {
    if (reviews[id] === undefined) {
      errors.push(
        `policy/registries/rules.yaml policyRuleReviews missing policy rule review: ${id}`,
      );
      continue;
    }
    checkPolicyRuleReviewEntry(
      reviews[id],
      `policy/registries/rules.yaml policyRuleReviews.${id}`,
      activeRules,
      errors,
    );
  }
  for (const id of Object.keys(reviews).sort((a, b) => a.localeCompare(b))) {
    if (!policyRuleSet.has(id)) {
      errors.push(
        `policy/registries/rules.yaml policyRuleReviews contains non-policy rule review: ${id}`,
      );
    }
  }
}
export function checkRuleRegistry(registry, repoRoot, policySource, errors) {
  if (Object.keys(registry).length === 0) {
    errors.push(
      "policy/registries/rules.yaml must exist and contain the rule status registry.",
    );
    return;
  }
  if (registry.schemaVersion !== 1) {
    errors.push("policy/registries/rules.yaml schemaVersion must be 1.");
  }
  checkInvestigationRequirements(
    registry.promotionRequirements?.investigation,
    errors,
  );
  checkStablePromotionRequirements(
    registry.promotionRequirements?.stable,
    errors,
  );
  checkClaudeAdvisory(registry.claudeAdvisory, repoRoot, errors);
  checkActiveRuleEntries(
    registry.rules,
    repoRoot,
    registry.promotionRequirements?.stable,
    errors,
  );
  checkRetiredRules(registry.retiredRules, repoRoot, errors);
  checkResearchCandidates(
    registry.researchCandidates,
    repoRoot,
    commandOwnedRuleIdsFromSemanticFactKinds(registry.semanticFactKinds),
    errors,
  );
  checkRuleFamilies(registry.ruleFamilies, registry, repoRoot, errors);
  checkPolicyRuleReviews(registry, policySource, errors);
}
