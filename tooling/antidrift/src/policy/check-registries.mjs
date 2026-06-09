import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import YAML from "yaml";

import plugin from "../eslint-plugin/index.js";

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

function activeAntidriftRules() {
  return new Set(
    Object.keys(plugin.rules ?? {}).map((rule) => `antidrift/${rule}`),
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

function checkActiveRuleEntries(rules, repoRoot, errors) {
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

function checkDecisionLocks(registry, errors) {
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
  checkActiveRuleEntries(registry.rules, repoRoot, errors);
  checkRetiredRules(registry.retiredRules, repoRoot, errors);
  checkResearchCandidates(registry.researchCandidates, repoRoot, errors);
  checkDecisionLocks(registry, errors);
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
    rules: readRegistry(policyDir, "rules", errors),
  };

  checkArchitecture(registries.architecture, errors);
  checkBoundaries(registries.boundaries, errors);
  checkDependencies(registries.dependencies, repoRoot, errors);
  checkDesignSystem(registries.designSystem, errors);
  checkDomain(registries.domain, repoRoot, errors);
  checkGateways(registries.gateways, repoRoot, errors);
  checkGenerated(registries.generated, repoRoot, errors);
  checkRulesRegistry(registries.rules, repoRoot, policySource, errors);

  for (const error of errors) report(error);
  return errors.length === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && !checkRegistries()) {
  process.exitCode = 1;
}
