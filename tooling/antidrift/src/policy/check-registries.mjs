import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import YAML from "yaml";

import plugin from "../eslint-plugin/index.js";
import {
  SEMANTIC_ADAPTERS,
  SEMANTIC_ADAPTER_CONTRACTS,
} from "../semantic-adapters/index.mjs";
import { SEMANTIC_FACT_KINDS } from "./lib/semantic-facts.mjs";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRegistry(policyDir, name, errors) {
  const file = join(policyDir, "registries", `${name}.yaml`);
  if (!existsSync(file)) return {};
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push(`policy/registries/${name}.yaml must contain a mapping.`);
      return {};
    }
    return parsed;
  } catch (error) {
    errors.push(
      `policy/registries/${name}.yaml could not be parsed: ${error.message}`,
    );
    return {};
  }
}

function readPolicySource(policyDir, errors) {
  const file = join(policyDir, "agent-guardrails.yaml");
  if (!existsSync(file)) return null;
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push("policy/agent-guardrails.yaml must contain a mapping.");
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(
      `policy/agent-guardrails.yaml could not be parsed: ${error.message}`,
    );
    return null;
  }
}

function readPackageJson(repoRoot, errors) {
  const file = join(repoRoot, "tooling", "antidrift", "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) ?? {};
    if (!isRecord(parsed)) {
      errors.push("tooling/antidrift/package.json must contain a mapping.");
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(
      `tooling/antidrift/package.json could not be parsed: ${error.message}`,
    );
    return null;
  }
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
    if (!isExported || !ts.isVariableStatement(statement)) continue;
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

function arrayLiteralStrings(initializer, exportName, label, errors) {
  const expression = unwrapExpression(initializer);
  if (!ts.isArrayLiteralExpression(expression)) {
    errors.push(
      `${label} valuesExport '${exportName}' must be an exported string array.`,
    );
    return null;
  }

  const values = [];
  for (const element of expression.elements) {
    if (
      !ts.isStringLiteral(element) &&
      !ts.isNoSubstitutionTemplateLiteral(element)
    ) {
      errors.push(
        `${label} valuesExport '${exportName}' must contain only string literals.`,
      );
      return null;
    }
    values.push(element.text);
  }
  return values;
}

function exportedStringArray(
  repoRoot,
  relativePath,
  exportName,
  label,
  errors,
) {
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) return null;
  const source = readFileSync(target, "utf8");
  const sourceFile = ts.createSourceFile(
    target,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = findExportedConst(sourceFile, exportName);

  if (declaration?.initializer) {
    return arrayLiteralStrings(
      declaration.initializer,
      exportName,
      label,
      errors,
    );
  }
  errors.push(
    `${label} valuesExport '${exportName}' was not found in ${relativePath}.`,
  );
  return null;
}

function requireMatchingValueExport(
  repoRoot,
  owner,
  exportName,
  values,
  label,
  errors,
) {
  if (exportName === undefined) return;
  if (typeof exportName !== "string" || exportName.length === 0) {
    errors.push(`${label}.valuesExport must be a string.`);
    return;
  }
  const exported = exportedStringArray(
    repoRoot,
    owner,
    exportName,
    label,
    errors,
  );
  if (!exported) return;
  if (
    values.length !== exported.length ||
    values.some((value, index) => value !== exported[index])
  ) {
    errors.push(
      `${label}.values must match exported ${exportName}: [${exported.join(", ")}]`,
    );
  }
}

function checkCanonicalEntities(entities, repoRoot, errors) {
  if (entities === undefined) return;
  if (!isRecord(entities)) {
    errors.push(
      "policy/registries/domain.yaml canonicalEntities must be a mapping.",
    );
    return;
  }
  for (const [name, owner] of Object.entries(entities)) {
    requireExistingPath(
      repoRoot,
      owner,
      `policy/registries/domain.yaml canonicalEntities.${name}`,
      errors,
    );
  }
}

function checkStatuses(statuses, repoRoot, errors) {
  if (statuses === undefined) return;
  if (!isRecord(statuses)) {
    errors.push("policy/registries/domain.yaml statuses must be a mapping.");
    return;
  }
  for (const [name, entry] of Object.entries(statuses)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/domain.yaml statuses.${name} must be a mapping.`,
      );
      continue;
    }
    requireExistingPath(
      repoRoot,
      entry.owner,
      `policy/registries/domain.yaml statuses.${name}.owner`,
      errors,
    );
    const values = stringArray(
      entry.values,
      `policy/registries/domain.yaml statuses.${name}.values`,
      errors,
    );
    requireMatchingValueExport(
      repoRoot,
      entry.owner,
      entry.valuesExport,
      values,
      `policy/registries/domain.yaml statuses.${name}`,
      errors,
    );
  }
}

function checkRoles(roles, repoRoot, errors) {
  if (roles === undefined) return;
  if (!isRecord(roles)) {
    errors.push("policy/registries/domain.yaml roles must be a mapping.");
    return;
  }
  requireExistingPath(
    repoRoot,
    roles.owner,
    "policy/registries/domain.yaml roles.owner",
    errors,
  );
  const values = stringArray(
    roles.values,
    "policy/registries/domain.yaml roles.values",
    errors,
  );
  requireMatchingValueExport(
    repoRoot,
    roles.owner,
    roles.valuesExport,
    values,
    "policy/registries/domain.yaml roles",
    errors,
  );
}

function checkDomain(registry, repoRoot, errors) {
  checkCanonicalEntities(registry.canonicalEntities, repoRoot, errors);
  checkStatuses(registry.statuses, repoRoot, errors);
  checkRoles(registry.roles, repoRoot, errors);
}

function checkGateways(registry, repoRoot, errors) {
  if (registry.approvedGateways === undefined) return;
  if (!isRecord(registry.approvedGateways)) {
    errors.push(
      "policy/registries/gateways.yaml approvedGateways must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.approvedGateways)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/gateways.yaml approvedGateways.${name} must be a mapping.`,
      );
      continue;
    }
    requireExistingPath(
      repoRoot,
      entry.wrapper,
      `policy/registries/gateways.yaml approvedGateways.${name}.wrapper`,
      errors,
    );
    stringArray(
      entry.bannedDirectImports,
      `policy/registries/gateways.yaml approvedGateways.${name}.bannedDirectImports`,
      errors,
    );
  }
}

function checkGenerated(registry, repoRoot, errors) {
  if (registry.generatedSources === undefined) return;
  if (!isRecord(registry.generatedSources)) {
    errors.push(
      "policy/registries/generated.yaml generatedSources must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.generatedSources)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/generated.yaml generatedSources.${name} must be a mapping.`,
      );
      continue;
    }
    if (entry.generated !== undefined && typeof entry.generated !== "string") {
      errors.push(
        `policy/registries/generated.yaml generatedSources.${name}.generated must be a string.`,
      );
    } else if (entry.generated !== undefined) {
      requireExistingPath(
        repoRoot,
        entry.generated,
        `policy/registries/generated.yaml generatedSources.${name}.generated`,
        errors,
      );
    }
    if (entry.wrapper !== undefined) {
      requireExistingPath(
        repoRoot,
        entry.wrapper,
        `policy/registries/generated.yaml generatedSources.${name}.wrapper`,
        errors,
      );
    }
    if (entry.bannedDirectImports !== undefined) {
      stringArray(
        entry.bannedDirectImports,
        `policy/registries/generated.yaml generatedSources.${name}.bannedDirectImports`,
        errors,
        { allowEmpty: true },
      );
    }
  }
}

function checkOwnership(registry, errors) {
  if (registry.packageTypeOwners === undefined) return;
  if (!isRecord(registry.packageTypeOwners)) {
    errors.push(
      "policy/registries/ownership.yaml packageTypeOwners must be a mapping.",
    );
    return;
  }
  for (const [name, entry] of Object.entries(registry.packageTypeOwners)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/ownership.yaml packageTypeOwners.${name} must be a mapping.`,
      );
      continue;
    }
    for (const key of ["package", "exportName", "reason"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        errors.push(
          `policy/registries/ownership.yaml packageTypeOwners.${name}.${key} must be a non-empty string.`,
        );
      }
    }
  }
}

function checkArchitectureLayers(layers, errors) {
  if (layers === undefined) return;
  if (!isRecord(layers)) {
    errors.push(
      "policy/registries/architecture.yaml layers must be a mapping.",
    );
    return;
  }
  const layerNames = new Set(Object.keys(layers));
  for (const [name, entry] of Object.entries(layers)) {
    if (!isRecord(entry)) {
      errors.push(
        `policy/registries/architecture.yaml layers.${name} must be a mapping.`,
      );
      continue;
    }
    stringArray(
      entry.roots,
      `policy/registries/architecture.yaml layers.${name}.roots`,
      errors,
    );
    for (const target of stringArray(
      entry.mayImport ?? [],
      `policy/registries/architecture.yaml layers.${name}.mayImport`,
      errors,
      { allowEmpty: true },
    )) {
      if (!layerNames.has(target)) {
        errors.push(
          `policy/registries/architecture.yaml layers.${name}.mayImport references unknown layer: ${target}`,
        );
      }
    }
  }
}

function checkForbiddenImports(forbiddenImports, errors) {
  if (forbiddenImports === undefined) return;
  if (!Array.isArray(forbiddenImports)) {
    errors.push(
      "policy/registries/architecture.yaml forbiddenImports must be an array.",
    );
    return;
  }
  for (const [index, entry] of forbiddenImports.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string"
    ) {
      errors.push(
        `policy/registries/architecture.yaml forbiddenImports.${index} must contain from and to strings.`,
      );
    }
  }
}

function checkArchitecture(registry, errors) {
  checkArchitectureLayers(registry.layers, errors);
  if (registry.publicEntrypoints !== undefined) {
    stringArray(
      registry.publicEntrypoints,
      "policy/registries/architecture.yaml publicEntrypoints",
      errors,
      { allowEmpty: true },
    );
  }
  checkForbiddenImports(registry.forbiddenImports, errors);
}

function checkBoundaries(registry, errors) {
  if (registry.serverBoundaryGlobs !== undefined) {
    stringArray(
      registry.serverBoundaryGlobs,
      "policy/registries/boundaries.yaml serverBoundaryGlobs",
      errors,
    );
  }
  if (registry.requiredCalls === undefined) return;
  if (!isRecord(registry.requiredCalls)) {
    errors.push(
      "policy/registries/boundaries.yaml requiredCalls must be a mapping.",
    );
    return;
  }
  for (const [name, calls] of Object.entries(registry.requiredCalls)) {
    stringArray(
      calls,
      `policy/registries/boundaries.yaml requiredCalls.${name}`,
      errors,
    );
  }
}

function checkDependencies(registry, repoRoot, errors) {
  const policy = registry.runtimeDependencyPolicy;
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    errors.push(
      "policy/registries/dependencies.yaml runtimeDependencyPolicy must be a mapping.",
    );
    return;
  }
  if (policy.requireApproval === true) {
    requireExistingPath(
      repoRoot,
      policy.approvalFile,
      "policy/registries/dependencies.yaml runtimeDependencyPolicy.approvalFile",
      errors,
    );
  }
  stringArray(
    policy.bannedVersionSpecifiers,
    "policy/registries/dependencies.yaml runtimeDependencyPolicy.bannedVersionSpecifiers",
    errors,
  );
}

function checkDesignSystem(registry, errors) {
  if (registry.semanticClassPrefixes !== undefined) {
    stringArray(
      registry.semanticClassPrefixes,
      "policy/registries/design-system.yaml semanticClassPrefixes",
      errors,
    );
  }
  for (const key of [
    "bannedRawTailwindColorPattern",
    "bannedHoverTranslatePattern",
  ]) {
    if (registry[key] === undefined) continue;
    if (typeof registry[key] !== "string") {
      errors.push(
        `policy/registries/design-system.yaml ${key} must be a string.`,
      );
      continue;
    }
    try {
      new RegExp(registry[key], "u");
    } catch (error) {
      errors.push(
        `policy/registries/design-system.yaml ${key} is not a valid regex: ${error.message}`,
      );
    }
  }
  if (registry.genericAiCopy !== undefined) {
    stringArray(
      registry.genericAiCopy,
      "policy/registries/design-system.yaml genericAiCopy",
      errors,
      { allowEmpty: true },
    );
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
const allowedSemanticFactCarriers = new Set([
  "semantic-adapter",
  "type-aware-eslint",
  "authority-registry",
  "repo-graph",
  "agent-ops",
  "model-assisted",
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
const allowedProofBuckets = new Set([
  "local-ast-source-shape",
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
  "repo-session-runtime",
]);
const stableProofBucketsRequiringSemanticAdapterClaim = new Set([
  "semantic-source-type-provenance",
  "authority-index-ownership",
  "graph-config-source",
]);
const allowedSemanticAdapterStatuses = new Set(["inline-pending"]);
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
const requiredDecisionLocks = new Map([
  ["antidrift/no-cycle", { status: "retired", location: "retiredRules" }],
  [
    "antidrift/no-inline-disable-without-ticket",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-sdk-direct-use",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-explicit-return-type-private-helper",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-silent-catch",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-thin-typed-factory-wrapper",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-obvious-comment",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-role-literal-in-type",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-cast-to-branded",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-unsafe-cast-chain",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "antidrift/no-status-triplet-state",
    { status: "retired", location: "retiredRules" },
  ],
  [
    "ecosystem/discriminated-union-exhaustiveness",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/import-cycle",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/disable-comment-description",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/gateway-restricted-imports",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/vitest-test-integrity",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/react-hooks-compiler",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
  [
    "ecosystem/sonar-sql-queries",
    { status: "ecosystem-covered", location: "researchCandidates" },
  ],
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
  if (!repoRoot) return;
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
  const proofBuckets = stringArray(entry.proofBuckets, `${label}.proofBuckets`, errors);
  checkAllowedValues(
    proofBuckets,
    allowedProofBuckets,
    `${label}.proofBuckets`,
    errors,
  );
  if (!hasNonStableBlocker(entry)) {
    errors.push(
      `${label} must document at least one non-stable blocker in concerns, unproven, or openReviewConcerns.`,
    );
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

function activeAntidriftRules() {
  return new Set(
    Object.keys(plugin.rules ?? {}).map((rule) => `antidrift/${rule}`),
  );
}

function emittedSemanticFactKinds(repoRoot) {
  const pluginSource = safeRepoPath(
    repoRoot,
    "tooling/antidrift/src/eslint-plugin/index.js",
  );
  if (!pluginSource || !existsSync(pluginSource)) return new Set();
  const source = readFileSync(pluginSource, "utf8");
  return new Set(
    [...source.matchAll(/\bfactKind:\s*["']([^"']+)["']/gu)].map(
      (match) => match[1],
    ),
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
  if (advisory === undefined) return;
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

function sortedStrings(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function semanticAdapterContractsForRuleId(rule) {
  return Object.values(SEMANTIC_ADAPTER_CONTRACTS).filter((contract) =>
    contract.rules.includes(rule),
  );
}

function cellIncludesAny(cell, values) {
  return values.some((value) => cell.includes(value));
}

function checkSemanticValidationMatrixAdapterContract(
  rule,
  cells,
  relativePath,
  errors,
) {
  const contracts = semanticAdapterContractsForRuleId(rule);
  if (contracts.length === 0) return;
  const carriers = sortedStrings(contracts.map((contract) => contract.carrier));
  if (!cellIncludesAny(cells[1] ?? "", carriers)) {
    errors.push(
      `${relativePath} row for ${rule} carrier must include shipped semantic adapter carrier: ${carriers.join("; ")}.`,
    );
  }
  const associations = sortedStrings(
    new Set(contracts.flatMap((contract) => contract.associations)),
  );
  if (!cellIncludesAny(cells[2] ?? "", associations)) {
    errors.push(
      `${relativePath} row for ${rule} association must include one shipped semantic adapter association: ${associations.join("; ")}.`,
    );
  }
}

function checkSemanticValidationMatrixPromotion(
  rule,
  cells,
  ruleEntry,
  relativePath,
  errors,
) {
  if (
    !isRecord(ruleEntry) ||
    ruleEntry.stable !== true ||
    !isRecord(ruleEntry.promotion) ||
    typeof ruleEntry.promotion.association !== "string" ||
    ruleEntry.promotion.association.length === 0
  ) {
    return;
  }
  if (!cells[2]?.includes(ruleEntry.promotion.association)) {
    errors.push(
      `${relativePath} row for ${rule} association must include stable promotion association: ${ruleEntry.promotion.association}.`,
    );
  }
  if (
    typeof ruleEntry.promotion.blockingThreshold === "string" &&
    ruleEntry.promotion.blockingThreshold.length > 0 &&
    !cells[3]?.includes(ruleEntry.promotion.blockingThreshold)
  ) {
    errors.push(
      `${relativePath} row for ${rule} blocking threshold must include stable promotion blockingThreshold: ${ruleEntry.promotion.blockingThreshold}.`,
    );
  }
  for (const field of ["noSinkBehavior", "noDeadWorkBehavior"]) {
    const value = ruleEntry.promotion[field];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !cells[5]?.includes(value)
    ) {
      errors.push(
        `${relativePath} row for ${rule} no-sink/no-dead-work behavior must include stable promotion ${field}: ${value}.`,
      );
    }
  }
}

function equalStringSets(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    sortedStrings(left).join("\0") === sortedStrings(right).join("\0")
  );
}

function checkShippedSemanticFactKindContract(entry, shipped, label, errors) {
  if (!isRecord(entry)) return;
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
}

function checkSemanticFactKindEntry(entry, label, activeRules, errors) {
  if (!isRecord(entry)) {
    errors.push(`${label} must be a mapping.`);
    return;
  }
  const rules = stringArray(entry.rules, `${label}.rules`, errors);
  for (const rule of rules) {
    if (!activeRules.has(rule)) {
      errors.push(`${label}.rules references unknown active rule: ${rule}`);
    }
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
  if (typeof value !== "string" || value.length === 0) return;
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
    if (entry?.stable !== true || !isRecord(entry.promotion)) continue;
    const proofBucket = entry.promotion.proofBucket;
    if (typeof proofBucket !== "string" || proofBucket.length === 0) continue;
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
    if (entry?.stable !== true || !isRecord(entry.promotion)) continue;
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
    if (!isRecord(contract) || !Array.isArray(contract.rules)) continue;
    for (const rule of contract.rules) {
      if (typeof rule === "string" && rule.length > 0) rules.add(rule);
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
  if (!isRecord(ruleEntries)) return;
  const claimedRules = claimedSemanticAdapterRules(contracts);
  for (const rule of sortedStrings(Object.keys(ruleEntries))) {
    const entry = ruleEntries[rule];
    if (entry?.stable !== true || !isRecord(entry.promotion)) continue;
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
  if (!isRecord(ruleEntries)) return;
  const claimedRules = claimedSemanticAdapterRules(contracts);
  for (const rule of sortedStrings(Object.keys(ruleEntries))) {
    const entry = ruleEntries[rule];
    if (!isRecord(entry) || entry.stable !== false) continue;
    const hasNonLocalBucket = ruleEntryProofBuckets(entry).some((bucket) =>
      stableProofBucketsRequiringSemanticAdapterClaim.has(bucket),
    );
    const required = hasNonLocalBucket && !claimedRules.has(rule);
    if (!required && entry.semanticAdapterStatus === undefined) continue;
    checkRuleSemanticAdapterStatus(
      entry.semanticAdapterStatus,
      `policy/registries/rules.yaml rules.${rule}`,
      errors,
      { required },
    );
  }
}

function semanticFactRulesMatchAdapter(factContract, rules) {
  if (!isRecord(factContract)) return false;
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
    if (!semanticFactRulesMatchAdapter(factContract, rules)) continue;
    const { adapterId } = factContract;
    if (typeof adapterId !== "string" || adapterId.length === 0) continue;
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
    if (!semanticFactRulesMatchAdapter(factContract, rules)) continue;
    if (!semanticFactAdapterIds.includes(factContract.adapterId)) continue;
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

function checkSemanticAdapterContractEntry(
  key,
  contract,
  activeRules,
  ruleEntries,
  semanticFactKinds,
  seenIds,
  seenSemanticFactAdapterIds,
  seenSemanticFactKinds,
  seenSubpaths,
  label,
  errors,
) {
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
    allowedProofBuckets,
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

  for (const key of sortedStrings(contractKeys)) {
    checkSemanticAdapterContractEntry(
      key,
      contracts[key],
      activeRules,
      ruleEntries,
      semanticFactKinds,
      seenIds,
      seenSemanticFactAdapterIds,
      seenSemanticFactKinds,
      seenSubpaths,
      label,
      errors,
    );
  }
  checkStableSemanticAdapterRuleClaims(contracts, ruleEntries, label, errors);
}

function checkSemanticAdapterPackageExportEntry(
  exportsMap,
  exportKey,
  expectedTypes,
  expectedImport,
  errors,
) {
  const label = "tooling/antidrift/package.json exports";
  const exportLabel = `${label}${exportKey}`;
  const entry = exportsMap[exportKey];
  if (!isRecord(entry)) {
    errors.push(`${label} missing semantic adapter subpath: ${exportKey}`);
    return;
  }
  if (entry.types !== expectedTypes) {
    errors.push(`${exportLabel}.types must be ${expectedTypes}.`);
  }
  if (entry.import !== expectedImport) {
    errors.push(`${exportLabel}.import must be ${expectedImport}.`);
  }
}

function requireExistingPackageExportPath(repoRoot, packagePath, label, errors) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    !packagePath.startsWith("./")
  ) {
    errors.push(`${label} must be a package-relative ./ path.`);
    return;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", packagePath.slice(2)),
  );
  if (!target) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return;
  }
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${packagePath}`);
  }
}

function packageExportTarget(repoRoot, packagePath) {
  if (
    typeof packagePath !== "string" ||
    packagePath.length === 0 ||
    !packagePath.startsWith("./")
  ) {
    return null;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", packagePath.slice(2)),
  );
  return target && existsSync(target) ? target : null;
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
      if (ts.isBindingElement(element)) addBindingNames(element.name, names);
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
    if (!element.isTypeOnly) names.add(element.name.text);
  }
}

function addExportedDeclarationName(statement, names) {
  if (!hasExportModifier(statement)) return;
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
  if (!target || !existsSync(target)) return null;
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
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function objectLiteralPropertyNames(expression) {
  const objectExpression = objectFreezeArgument(expression);
  if (!ts.isObjectLiteralExpression(objectExpression)) return null;
  const names = new Set();
  for (const property of objectExpression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text);
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = propertyNameText(property.name);
      if (name) names.add(name);
    }
  }
  return names;
}

function exportedConstObjectKeys(sourceFile, exportName) {
  const declaration = findExportedConst(sourceFile, exportName);
  if (!declaration) return null;
  return objectLiteralPropertyNames(declaration.initializer);
}

function findExportedVariableDeclaration(sourceFile, exportName) {
  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported || !ts.isVariableStatement(statement)) continue;
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
  if (!ts.isTypeLiteralNode(literal)) return null;
  const names = new Set();
  for (const member of literal.members) {
    if (
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.name
    ) {
      const name = propertyNameText(member.name);
      if (name) names.add(name);
    }
  }
  return names;
}

function exportedConstTypePropertyNames(sourceFile, exportName) {
  const declaration = findExportedVariableDeclaration(sourceFile, exportName);
  if (!declaration?.type) return null;
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
  if (
    ts.isLiteralTypeNode(typeNode) &&
    ts.isStringLiteral(typeNode.literal)
  ) {
    return typeNode.literal.text;
  }
  return null;
}

function exportedStringUnionValues(sourceFile, typeName) {
  const alias = findExportedTypeAlias(sourceFile, typeName);
  if (!alias) return null;
  const values = new Set();
  if (ts.isUnionTypeNode(alias.type)) {
    for (const typeNode of alias.type.types) {
      const value = stringLiteralTypeValue(typeNode);
      if (value) values.add(value);
    }
    return values;
  }
  const value = stringLiteralTypeValue(alias.type);
  if (value) values.add(value);
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
    if (!actual.has(key)) errors.push(`${label} ${missing}: ${key}`);
  }
  if (!unexpected) return;
  for (const key of sortedStrings(actual)) {
    if (!expected.has(key)) errors.push(`${label} ${unexpected}: ${key}`);
  }
}

function checkSemanticAdapterRuntimeAggregate(contracts, repoRoot, errors) {
  const relativePath = "tooling/antidrift/src/semantic-adapters/index.mjs";
  const source = semanticAdapterAggregateSource(
    repoRoot,
    relativePath,
    ts.ScriptKind.JS,
  );
  if (!source) return;
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
  if (!source) return;
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

function checkPackageExportRuntimeDeclarations(
  exportLabel,
  typesPath,
  importPath,
  repoRoot,
  errors,
) {
  const runtimeTarget = packageExportTarget(repoRoot, importPath);
  const typeTarget = packageExportTarget(repoRoot, typesPath);
  if (!runtimeTarget || !typeTarget) return;
  const runtimeNames = packageExportedValueNames(
    readFileSync(runtimeTarget, "utf8"),
    importPath,
    ts.ScriptKind.JS,
  );
  const typeNames = packageExportedValueNames(
    readFileSync(typeTarget, "utf8"),
    typesPath,
    ts.ScriptKind.TS,
  );
  for (const name of sortedStrings(runtimeNames)) {
    if (!typeNames.has(name)) {
      errors.push(
        `${exportLabel}.import runtime export ${name} is missing from types path ${typesPath}`,
      );
    }
  }
  for (const name of sortedStrings(typeNames)) {
    if (!runtimeNames.has(name)) {
      errors.push(
        `${exportLabel}.types declaration ${name} is missing from runtime import path ${importPath}`,
      );
    }
  }
}

function checkPackageExportEntryFilesAndDeclarations(
  exportKey,
  entry,
  repoRoot,
  errors,
) {
  if (!isRecord(entry)) return;
  if (typeof entry.types !== "string" || typeof entry.import !== "string") {
    return;
  }
  const label = `tooling/antidrift/package.json exports${exportKey}`;
  requireExistingPackageExportPath(repoRoot, entry.types, `${label}.types`, errors);
  requireExistingPackageExportPath(
    repoRoot,
    entry.import,
    `${label}.import`,
    errors,
  );
  checkPackageExportRuntimeDeclarations(
    label,
    entry.types,
    entry.import,
    repoRoot,
    errors,
  );
}

function checkPackageExportFilesAndDeclarations(packageJson, repoRoot, errors) {
  const exportsMap = packageJson.exports;
  if (!isRecord(exportsMap)) return;
  for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
    checkPackageExportEntryFilesAndDeclarations(
      exportKey,
      exportsMap[exportKey],
      repoRoot,
      errors,
    );
  }
}

function packageRelativeTarget(repoRoot, packagePath, label, errors) {
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    errors.push(`${label} must be a package-relative path.`);
    return null;
  }
  const relativePackagePath = packagePath.startsWith("./")
    ? packagePath.slice(2)
    : packagePath;
  if (
    isAbsolute(relativePackagePath) ||
    relativePackagePath === ".." ||
    relativePackagePath.startsWith("../") ||
    relativePackagePath.includes("/../")
  ) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return null;
  }
  const target = safeRepoPath(
    repoRoot,
    join("tooling", "antidrift", relativePackagePath),
  );
  if (!target) {
    errors.push(`${label} must stay inside tooling/antidrift.`);
    return null;
  }
  return target;
}

function requireExistingPackageBinPath(repoRoot, packagePath, label, errors) {
  const target = packageRelativeTarget(repoRoot, packagePath, label, errors);
  if (!target) return null;
  if (!existsSync(target)) {
    errors.push(`${label} path does not exist: ${packagePath}`);
    return null;
  }
  return target;
}

function checkPackageBinTarget(binary, packagePath, repoRoot, errors) {
  const label = `tooling/antidrift/package.json bin.${binary}`;
  const target = requireExistingPackageBinPath(repoRoot, packagePath, label, errors);
  if (!target) return;
  const firstLine = readFileSync(target, "utf8").split(/\r?\n/u, 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    errors.push(`${label} must start with #!/usr/bin/env node.`);
  }
}

function checkPackageBinTargets(packageJson, repoRoot, errors) {
  if (packageJson.bin === undefined) return;
  if (typeof packageJson.bin === "string") {
    const binary =
      typeof packageJson.name === "string" && packageJson.name.length > 0
        ? packageJson.name
        : "default";
    checkPackageBinTarget(binary, packageJson.bin, repoRoot, errors);
    return;
  }
  if (!isRecord(packageJson.bin)) {
    errors.push("tooling/antidrift/package.json bin must be a string or mapping.");
    return;
  }
  for (const binary of sortedStrings(Object.keys(packageJson.bin))) {
    checkPackageBinTarget(binary, packageJson.bin[binary], repoRoot, errors);
  }
}

function packageExportPublicSpecifier(packageName, exportKey) {
  if (exportKey === ".") return packageName;
  if (exportKey.startsWith("./")) return `${packageName}/${exportKey.slice(2)}`;
  return null;
}

function checkPackageReadmePublicEntry(readme, specifier, errors) {
  if (!readme.includes(`\`${specifier}\``)) {
    errors.push(
      `tooling/antidrift/README.md public entry points missing package export: ${specifier}`,
    );
  }
}

function checkPackageReadmeBinaryEntry(readme, binary, errors) {
  if (!readme.includes(`\`${binary}\``)) {
    errors.push(
      `tooling/antidrift/README.md public entry points missing CLI binary: ${binary}`,
    );
  }
}

function readmeCodeSpans(readme) {
  return [...readme.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
}

function packageReadmeSpecifiers(readme, packageName) {
  return readmeCodeSpans(readme).filter(
    (span) => span === packageName || span.startsWith(`${packageName}/`),
  );
}

function checkPackageReadmeNoStalePublicEntries(
  readme,
  packageName,
  expectedSpecifiers,
  errors,
) {
  for (const specifier of packageReadmeSpecifiers(readme, packageName)) {
    if (!expectedSpecifiers.has(specifier)) {
      errors.push(
        `tooling/antidrift/README.md public entry points lists non-exported package specifier: ${specifier}`,
      );
    }
  }
}

function checkPackageReadmePublicEntryPoints(packageJson, repoRoot, errors) {
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    return;
  }
  const target = safeRepoPath(repoRoot, "tooling/antidrift/README.md");
  if (!target || !existsSync(target)) return;
  const readme = readFileSync(target, "utf8");
  const exportsMap = packageJson.exports;
  const expectedSpecifiers = new Set();
  if (isRecord(exportsMap)) {
    for (const exportKey of sortedStrings(Object.keys(exportsMap))) {
      const specifier = packageExportPublicSpecifier(
        packageJson.name,
        exportKey,
      );
      if (specifier) {
        expectedSpecifiers.add(specifier);
        checkPackageReadmePublicEntry(readme, specifier, errors);
      }
    }
    checkPackageReadmeNoStalePublicEntries(
      readme,
      packageJson.name,
      expectedSpecifiers,
      errors,
    );
  }
  if (typeof packageJson.bin === "string") {
    checkPackageReadmeBinaryEntry(readme, packageJson.name, errors);
  } else if (isRecord(packageJson.bin)) {
    for (const binary of sortedStrings(Object.keys(packageJson.bin))) {
      checkPackageReadmeBinaryEntry(readme, binary, errors);
    }
  }
}

function checkSemanticAdapterPackageExports(contracts, repoRoot, errors) {
  const packageJson = readPackageJson(repoRoot, errors);
  if (!packageJson) return;
  const exportsMap = packageJson.exports;
  if (!isRecord(exportsMap)) {
    errors.push("tooling/antidrift/package.json exports must be a mapping.");
    return;
  }

  checkSemanticAdapterPackageExportEntry(
    exportsMap,
    "./semantic-adapters",
    "./src/semantic-adapters/index.d.mts",
    "./src/semantic-adapters/index.mjs",
    errors,
  );

  for (const contract of Object.values(contracts)) {
    if (!isRecord(contract) || typeof contract.id !== "string") continue;
    const exportKey = `./semantic-adapters/${contract.id}`;
    checkSemanticAdapterPackageExportEntry(
      exportsMap,
      exportKey,
      `./src/semantic-adapters/${contract.id}.d.mts`,
      `./src/semantic-adapters/${contract.id}.mjs`,
      errors,
    );
  }
  checkPackageExportFilesAndDeclarations(packageJson, repoRoot, errors);
  checkPackageBinTargets(packageJson, repoRoot, errors);
  checkPackageReadmePublicEntryPoints(packageJson, repoRoot, errors);
}

function checkSemanticFactKinds(registry, repoRoot, errors) {
  const emitted = emittedSemanticFactKinds(repoRoot);
  if (!requireSemanticFactKindsSection(registry, emitted, errors)) return;

  const entries = registry.semanticFactKinds;
  checkEmittedSemanticFactKindCoverage(entries, emitted, errors);
  checkSemanticFactKindEntries(entries, activeAntidriftRules(), errors);
  checkShippedSemanticFactKindCoverage(entries, errors);
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
  if (retiredRules === undefined) return;
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

function checkResearchCandidates(researchCandidates, repoRoot, errors) {
  if (researchCandidates === undefined) return;
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
  }
}

function lockedDecisionBucket(registry, id, location) {
  if (location === "retiredRules") return registry.retiredRules?.[id];
  if (location === "researchCandidates") {
    return registry.researchCandidates?.[id];
  }
  return undefined;
}

function checkUnexpectedDecisionLocks(registry, errors) {
  for (const id of Object.keys(registry.decisionLocks).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (!requiredDecisionLocks.has(id)) {
      errors.push(
        `policy/registries/rules.yaml decisionLocks contains unlocked decision; add it to check-registries.mjs before relying on it: ${id}`,
      );
    }
  }
}

function checkRequiredDecisionLock(registry, id, expected, errors) {
  const lock = registry.decisionLocks[id];
  if (!isRecord(lock)) {
    errors.push(
      `policy/registries/rules.yaml decisionLocks missing locked decision: ${id}`,
    );
    return;
  }
  if (lock.status !== expected.status) {
    errors.push(
      `policy/registries/rules.yaml decisionLocks.${id}.status must remain ${expected.status}.`,
    );
  }
  if (lock.location !== expected.location) {
    errors.push(
      `policy/registries/rules.yaml decisionLocks.${id}.location must remain ${expected.location}.`,
    );
  }
  requireString(
    lock.reason,
    `policy/registries/rules.yaml decisionLocks.${id}.reason`,
    errors,
  );
  requireString(
    lock.replacement,
    `policy/registries/rules.yaml decisionLocks.${id}.replacement`,
    errors,
  );

  if (registry.rules?.[id] !== undefined) {
    errors.push(
      `policy/registries/rules.yaml rules must not reactivate locked decision: ${id}`,
    );
  }

  const lockedEntry = lockedDecisionBucket(registry, id, expected.location);
  if (!isRecord(lockedEntry)) {
    errors.push(
      `policy/registries/rules.yaml ${expected.location} must contain locked decision: ${id}`,
    );
  } else if (lockedEntry.status !== expected.status) {
    errors.push(
      `policy/registries/rules.yaml ${expected.location}.${id}.status must remain ${expected.status}.`,
    );
  }
}

function packageRuleReferences(text) {
  return new Set(
    [...text.matchAll(/\bantidrift\/(?:no|require)-[A-Za-z0-9_-]+\b/gu)].map(
      (match) => match[0],
    ),
  );
}

function checkLockedRetiredReplacementReferenceDoc(
  registry,
  id,
  lock,
  repoRoot,
  errors,
) {
  if (
    typeof lock.replacement !== "string" ||
    !lock.replacement.startsWith("antidrift/") ||
    !repoRoot
  ) {
    return;
  }
  const retiredEntry = registry.retiredRules?.[id];
  if (
    !isRecord(retiredEntry) ||
    typeof retiredEntry.referenceDoc !== "string" ||
    retiredEntry.referenceDoc.length === 0
  ) {
    return;
  }
  const target = safeRepoPath(repoRoot, retiredEntry.referenceDoc);
  if (!target || !existsSync(target)) return;
  const text = readFileSync(target, "utf8");
  if (!text.includes(lock.replacement)) {
    errors.push(
      `policy/registries/rules.yaml retiredRules.${id}.referenceDoc must mention decisionLocks replacement ${lock.replacement}.`,
    );
  }
  const knownRules = knownRuleIds(registry);
  for (const reference of sortedStrings(packageRuleReferences(text))) {
    if (!knownRules.has(reference)) {
      errors.push(
        `${retiredEntry.referenceDoc} references unknown package rule ${reference} from retired decision ${id}.`,
      );
    }
  }
}

function checkDecisionLocks(registry, repoRoot, errors) {
  if (!isRecord(registry.decisionLocks)) {
    errors.push(
      "policy/registries/rules.yaml decisionLocks must be a mapping.",
    );
    return;
  }

  checkUnexpectedDecisionLocks(registry, errors);

  for (const [id, expected] of [...requiredDecisionLocks.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    checkRequiredDecisionLock(registry, id, expected, errors);
    const lock = registry.decisionLocks[id];
    if (expected.status === "retired" && isRecord(lock)) {
      checkLockedRetiredReplacementReferenceDoc(
        registry,
        id,
        lock,
        repoRoot,
        errors,
      );
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
  const lockedRules = rules.filter((rule) => requiredDecisionLocks.has(rule));
  if (lockedRules.length > 0 && subsetEntry.historical !== true) {
    errors.push(
      `${subsetLabel}.historical must be true when referencing locked decisions: ${lockedRules.join(", ")}`,
    );
  }
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
  if (ruleFamilies === undefined) return;
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
  if (!rules) return;

  for (const [ruleIndex, rule] of rules.entries()) {
    const ruleLabel = `${clusterLabel}.rules[${ruleIndex}]`;
    const id = policyRuleId(rule, ruleLabel, errors);
    if (id) addUniquePolicyRuleId(ids, seen, id, errors);
  }
}

function policyClusters(policySource, errors) {
  if (policySource === null) return null;
  if (Array.isArray(policySource.clusters)) return policySource.clusters;
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
  if (policyRuleIds.length === 0) return;
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

function checkSemanticValidationMatrix(repoRoot, activeRules, ruleEntries, errors) {
  const relativePath = "docs/semantic-validation-matrix.md";
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) {
    errors.push(
      `${relativePath} must exist and contain active rule proof rows.`,
    );
    return;
  }
  const matrix = readFileSync(target, "utf8");
  const rows = markdownRuleRows(matrix);
  for (const rule of sortedStrings(activeRules)) {
    const cells = rows.get(rule);
    if (!cells) {
      errors.push(`${relativePath} missing active rule row: ${rule}`);
      continue;
    }
    if (
      [cells[1], cells[2], cells[3], cells[4]].some(
        (cell) => typeof cell !== "string" || cell.length === 0,
      )
    ) {
      errors.push(
        `${relativePath} row for ${rule} must declare carrier, semantic association or authority fact, blocking threshold, and validation and gap.`,
      );
    }
    if (typeof cells[5] !== "string" || cells[5].length === 0) {
      errors.push(
        `${relativePath} row for ${rule} must declare no-sink or no-dead-work behavior.`,
      );
    }
    checkSemanticValidationMatrixAdapterContract(
      rule,
      cells,
      relativePath,
      errors,
    );
    checkSemanticValidationMatrixPromotion(
      rule,
      cells,
      ruleEntries?.[rule],
      relativePath,
      errors,
    );
  }
}

function statusCellClaimsStable(statusCell) {
  return /\bstable\b/u.test(statusCell.toLowerCase());
}

function checkRealCorpusValidationStatus(
  rule,
  statusCell,
  ruleEntry,
  relativePath,
  errors,
) {
  if (!isRecord(ruleEntry)) return;
  const normalized = statusCell.toLowerCase();
  if (ruleEntry.stable === true && !statusCellClaimsStable(statusCell)) {
    errors.push(
      `${relativePath} row for ${rule} status must include stable because policy/registries/rules.yaml stable is true.`,
    );
  }
  if (ruleEntry.stable === false && statusCellClaimsStable(statusCell)) {
    errors.push(
      `${relativePath} row for ${rule} status must not claim stable when policy/registries/rules.yaml stable is false.`,
    );
  }
  if (
    ruleEntry.stable !== true &&
    typeof ruleEntry.status === "string" &&
    ruleEntry.status.length > 0 &&
    !normalized.includes(ruleEntry.status.toLowerCase())
  ) {
    errors.push(
      `${relativePath} row for ${rule} status must include registry status '${ruleEntry.status}'.`,
    );
  }
}

function checkRealCorpusValidationPromotion(
  rule,
  evidenceCell,
  ruleEntry,
  relativePath,
  errors,
) {
  if (
    !isRecord(ruleEntry) ||
    ruleEntry.stable !== true ||
    !isRecord(ruleEntry.promotion) ||
    typeof ruleEntry.promotion.corpusEvidence !== "string" ||
    ruleEntry.promotion.corpusEvidence.length === 0
  ) {
    return;
  }
  if (!evidenceCell.includes(ruleEntry.promotion.corpusEvidence)) {
    errors.push(
      `${relativePath} row for ${rule} evidence must include stable promotion corpusEvidence: ${ruleEntry.promotion.corpusEvidence}.`,
    );
  }
}

function checkRealCorpusValidation(repoRoot, activeRules, ruleEntries, errors) {
  const relativePath = "docs/real-corpus-validation.md";
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) {
    errors.push(
      `${relativePath} must exist and contain active rule corpus evidence rows.`,
    );
    return;
  }
  const matrix = readFileSync(target, "utf8");
  const rows = markdownRuleRows(matrix);
  for (const rule of sortedStrings(activeRules)) {
    const cells = rows.get(rule);
    if (!cells) {
      errors.push(`${relativePath} missing active rule row: ${rule}`);
      continue;
    }
    if (
      [cells[1], cells[2]].some(
        (cell) => typeof cell !== "string" || cell.length === 0,
      )
    ) {
      errors.push(
        `${relativePath} row for ${rule} must declare status and real-source evidence.`,
      );
    }
    checkRealCorpusValidationStatus(
      rule,
      cells[1] ?? "",
      ruleEntries?.[rule],
      relativePath,
      errors,
    );
    checkRealCorpusValidationPromotion(
      rule,
      cells[2] ?? "",
      ruleEntries?.[rule],
      relativePath,
      errors,
    );
  }
}

function stablePromotionInventoryRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = markdownTableCells(line);
    if (!cells || markdownTableSeparator(cells)) continue;
    const rule = cells[1]?.match(/`(antidrift\/[^`]+)`/)?.[1];
    if (rule) rows.set(rule, cells);
  }
  return rows;
}

function normalizedInventoryText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function promotionInventoryRepositoryAliases(repository) {
  return (
    new Map([
      ["sudocode-main", ["sudocode-main", "Sudocode"]],
      ["claude-code-source", ["claude-code-source", "Claude Code Source"]],
    ]).get(repository) ?? [repository]
  );
}

function stablePromotionInventoryMentionsRepository(cells, repository) {
  const evidenceText = normalizedInventoryText(cells.slice(4, 7).join(" "));
  return promotionInventoryRepositoryAliases(repository).some((alias) =>
    evidenceText.includes(normalizedInventoryText(alias)),
  );
}

function checkStablePromotionInventoryRow(relativePath, rule, entry, cells, errors) {
  if (cells[2] !== "stable") {
    errors.push(
      `${relativePath} row for ${rule} promotion bucket must be stable because policy/registries/rules.yaml stable is true.`,
    );
  }
  const ecosystemComparison = entry.promotion?.ecosystemComparison;
  if (
    typeof ecosystemComparison === "string" &&
    ecosystemComparison.length > 0 &&
    !cells[6]?.includes(ecosystemComparison)
  ) {
    errors.push(
      `${relativePath} row for ${rule} why must include stable promotion ecosystemComparison: ${ecosystemComparison}.`,
    );
  }
  const repositories = Array.isArray(entry.corpusRepositories)
    ? entry.corpusRepositories
    : [];
  for (const repository of repositories) {
    if (!stablePromotionInventoryMentionsRepository(cells, repository)) {
      errors.push(
        `${relativePath} row for ${rule} must mention registry corpus repository: ${repository}.`,
      );
    }
  }
}

function checkStablePromotionInventory(repoRoot, ruleEntries, errors) {
  const stableEntries = Object.entries(ruleEntries ?? {}).filter(
    ([, entry]) => entry?.stable === true,
  );
  if (stableEntries.length === 0) return;
  const relativePath = "docs/stable-promotion-inventory.md";
  const target = safeRepoPath(repoRoot, relativePath);
  if (!target || !existsSync(target)) {
    errors.push(
      `${relativePath} must exist and contain stable promotion rows.`,
    );
    return;
  }
  const inventory = readFileSync(target, "utf8");
  const rows = stablePromotionInventoryRows(inventory);
  for (const [rule, entry] of stableEntries) {
    const cells = rows.get(rule);
    if (!cells) {
      errors.push(`${relativePath} missing stable promotion row: ${rule}`);
      continue;
    }
    checkStablePromotionInventoryRow(relativePath, rule, entry, cells, errors);
  }
}

function markdownRuleRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = markdownTableCells(line);
    if (!cells || markdownTableSeparator(cells)) continue;
    const rule = cells[0]?.match(/`(antidrift\/[^`]+)`/)?.[1];
    if (rule) rows.set(rule, cells);
  }
  return rows;
}

function markdownTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function markdownTableSeparator(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function checkRulesRegistry(registry, repoRoot, policySource, errors) {
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
  const activeRules = activeAntidriftRules();
  checkSemanticValidationMatrix(repoRoot, activeRules, registry.rules, errors);
  checkRealCorpusValidation(repoRoot, activeRules, registry.rules, errors);
  checkStablePromotionInventory(repoRoot, registry.rules, errors);
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
  checkSemanticAdapterPackageExports(
    SEMANTIC_ADAPTER_CONTRACTS,
    repoRoot,
    errors,
  );
  checkSemanticFactKinds(registry, repoRoot, errors);
  checkRetiredRules(registry.retiredRules, repoRoot, errors);
  checkResearchCandidates(registry.researchCandidates, repoRoot, errors);
  checkDecisionLocks(registry, repoRoot, errors);
  checkRuleFamilies(registry.ruleFamilies, registry, repoRoot, errors);
  checkPolicyRuleReviews(registry, policySource, errors);
}

export function checkRegistries({
  repoRoot = process.cwd(),
  policyDir = join(repoRoot, "policy"),
  report = console.error,
} = {}) {
  const errors = [];
  const policySource = readPolicySource(policyDir, errors);
  const registries = {
    architecture: readRegistry(policyDir, "architecture", errors),
    boundaries: readRegistry(policyDir, "boundaries", errors),
    dependencies: readRegistry(policyDir, "dependencies", errors),
    designSystem: readRegistry(policyDir, "design-system", errors),
    domain: readRegistry(policyDir, "domain", errors),
    gateways: readRegistry(policyDir, "gateways", errors),
    generated: readRegistry(policyDir, "generated", errors),
    ownership: readRegistry(policyDir, "ownership", errors),
    rules: readRegistry(policyDir, "rules", errors),
  };

  checkArchitecture(registries.architecture, errors);
  checkBoundaries(registries.boundaries, errors);
  checkDependencies(registries.dependencies, repoRoot, errors);
  checkDesignSystem(registries.designSystem, errors);
  checkDomain(registries.domain, repoRoot, errors);
  checkGateways(registries.gateways, repoRoot, errors);
  checkGenerated(registries.generated, repoRoot, errors);
  checkOwnership(registries.ownership, errors);
  checkRulesRegistry(registries.rules, repoRoot, policySource, errors);

  for (const error of errors) report(error);
  return errors.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRegistries()) {
  process.exitCode = 1;
}
