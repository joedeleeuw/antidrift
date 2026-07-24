import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import eslintPlugin from "../../src/eslint-plugin/index.js";
import oxlintPlugin from "../../src/oxlint-plugin/index.js";
import { SEMANTIC_ADAPTER_CONTRACTS } from "../../src/semantic-adapters/index.mjs";
import { SEMANTIC_FACT_KINDS } from "../../src/policy/lib/semantic-facts.mjs";

export const plugin = {
  rules: {
    ...eslintPlugin.rules,
    ...oxlintPlugin.rules,
  },
};
export function workspace() {
  const root = mkdtempSync(join(tmpdir(), "antidrift-registries-"));
  mkdirSync(join(root, "policy", "registries"), { recursive: true });
  return root;
}
export function writeRegistry(root, name, text) {
  writeFileSync(join(root, "policy", "registries", `${name}.yaml`), text);
}
export function touch(root, file) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), "");
}
export function writePolicySource(root, ruleIds) {
  const rules = ruleIds
    .map(
      (id) => `      - id: ${id}
        severity: error
        detector: testDetector
        message: Test message.
`,
    )
    .join("");
  writeFileSync(
    join(root, "policy", "agent-guardrails.yaml"),
    `version: 1
clusters:
  - id: test-cluster
    owner: test-owner
    rules:
${rules}
`,
  );
}
export function writePackageJson(root, contents) {
  mkdirSync(join(root, "tooling", "antidrift"), { recursive: true });
  writeFileSync(
    join(root, "tooling", "antidrift", "package.json"),
    `${JSON.stringify(contents, null, 2)}\n`,
  );
}
export function semanticAdapterPackageExports() {
  const exports = {
    "./semantic-adapters": {
      types: "./src/semantic-adapters/index.d.mts",
      import: "./src/semantic-adapters/index.mjs",
    },
  };
  for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
    exports[`./semantic-adapters/${contract.id}`] = {
      types: `./src/semantic-adapters/${contract.id}.d.mts`,
      import: `./src/semantic-adapters/${contract.id}.mjs`,
    };
  }
  return exports;
}
export function semanticAdapterContractKeys() {
  return Object.keys(SEMANTIC_ADAPTER_CONTRACTS).sort((a, b) =>
    a.localeCompare(b),
  );
}
export function semanticAdapterAggregateRuntimeSource(
  keys = semanticAdapterContractKeys(),
) {
  return [
    ...keys.map((key) => {
      const id = SEMANTIC_ADAPTER_CONTRACTS[key]?.id ?? key;
      return `import * as ${key} from "./${id}.mjs";`;
    }),
    "",
    "export {",
    ...keys.map((key) => `  ${key},`),
    "};",
    "",
    "export const SEMANTIC_ADAPTERS = Object.freeze({",
    ...keys.map((key) => `  ${key},`),
    "});",
    "",
    "export const SEMANTIC_ADAPTER_CONTRACTS = Object.freeze({});",
    "",
  ].join("\n");
}
export function semanticAdapterAggregateTypeSource(
  keys = semanticAdapterContractKeys(),
) {
  return [
    ...keys.map((key) => {
      const id = SEMANTIC_ADAPTER_CONTRACTS[key]?.id ?? key;
      return `import * as ${key} from "./${id}.mjs";`;
    }),
    "",
    "export {",
    ...keys.map((key) => `  ${key},`),
    "};",
    "",
    "export const SEMANTIC_ADAPTERS: Readonly<{",
    ...keys.map((key) => `  ${key}: typeof ${key};`),
    "}>;",
    "",
    "export type SemanticAdapterContractKey =",
    ...keys.map(
      (key, index) =>
        `  | ${JSON.stringify(key)}${index === keys.length - 1 ? ";" : ""}`,
    ),
    "",
    "export const SEMANTIC_ADAPTER_CONTRACTS: Readonly<Record<SemanticAdapterContractKey, unknown>>;",
    "",
  ].join("\n");
}
export function writeSemanticAdapterAggregateFiles(root) {
  mkdirSync(join(root, "tooling", "antidrift", "src", "semantic-adapters"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "tooling", "antidrift", "src", "semantic-adapters", "index.mjs"),
    semanticAdapterAggregateRuntimeSource(),
  );
  writeFileSync(
    join(
      root,
      "tooling",
      "antidrift",
      "src",
      "semantic-adapters",
      "index.d.mts",
    ),
    semanticAdapterAggregateTypeSource(),
  );
}
export function touchSemanticAdapterPackageExportFiles(root) {
  writeSemanticAdapterAggregateFiles(root);
  for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.d.mts`);
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.mjs`);
  }
}
export function yamlFlowStrings(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}
export function replaceYamlSectionField(text, sectionName, fieldName, value) {
  const lines = text.split("\n");
  let inSection = false;
  for (const [index, line] of lines.entries()) {
    if (line === `  ${sectionName}:`) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("  ") && !line.startsWith("    ")) {
      break;
    }
    if (inSection && line.startsWith(`    ${fieldName}: `)) {
      lines[index] = `    ${fieldName}: ${value}`;
      break;
    }
  }
  return lines.join("\n");
}
export function semanticFactKindSections() {
  const entries = Object.entries(SEMANTIC_FACT_KINDS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([factKind, contract]) => {
      const commandIdsLine = contract.commandIds
        ? `    commandIds: ${yamlFlowStrings(contract.commandIds)}\n`
        : "";
      return `  ${factKind}:
    rules: ${yamlFlowStrings(contract.rules)}
${commandIdsLine}    adapterId: ${contract.adapterId}
    carrier: ${contract.carrier}
    confidence: ${yamlFlowStrings(contract.confidence)}
    emission: ${yamlFlowStrings(contract.emission)}
    association: ${JSON.stringify(contract.association)}
    noSinkBehavior: ${JSON.stringify(contract.noSinkBehavior)}
    payloadFields: ${yamlFlowStrings(contract.payloadFields)}
`;
    })
    .join("");
  return `semanticFactKinds:
${entries}`;
}
export const lockedRetiredRules = [
  "antidrift/no-cycle",
  "antidrift/no-inline-disable-without-ticket",
  "antidrift/no-sdk-direct-use",
  "antidrift/no-explicit-return-type-private-helper",
  "antidrift/no-silent-catch",
  "antidrift/no-thin-typed-factory-wrapper",
  "antidrift/no-obvious-comment",
  "antidrift/no-role-literal-in-type",
  "antidrift/no-cast-to-branded",
  "antidrift/no-unsafe-cast-chain",
  "antidrift/no-status-triplet-state",
];
export const lockedEcosystemCandidates = [
  "ecosystem/discriminated-union-exhaustiveness",
  "ecosystem/import-cycle",
  "ecosystem/disable-comment-description",
  "ecosystem/gateway-restricted-imports",
  "ecosystem/vitest-test-integrity",
  "ecosystem/react-hooks-compiler",
  "ecosystem/sql-query-plugins",
];
export function lockedRuleSections(root) {
  touch(root, "docs/locked-rule.md");
  const retiredRules = lockedRetiredRules
    .map(
      (rule) => `  ${rule}:
    status: retired
    reason: Test retired decision.
`,
    )
    .join("");
  const researchCandidates = lockedEcosystemCandidates
    .map(
      (rule) => `  ${rule}:
    status: ecosystem-covered
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/locked-rule.md
    nextAction: Test action.
`,
    )
    .join("");
  return `
retiredRules:
${retiredRules}
researchCandidates:
${researchCandidates}`;
}
export function writeValidRulesRegistry(root) {
  touch(root, "docs/rule-roadmap.md");
  const rules = Object.keys(plugin.rules)
    .sort((a, b) => a.localeCompare(b))
    .map(
      (rule) => `  antidrift/${rule}:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
    concerns:
      - Test non-stable blocker.
    external:
      state: net-antidrift
      support: none
      candidates: []
      decision: own-antidrift
      whyThisState: No supported equivalent is declared in this synthetic registry.
      whyNotOtherState: Not ecosystem-covered because no upstream rule candidate is listed.
    examples:
      flags:
        - bad()
      allows:
        - good()
    nextAction: Test action.
`,
    )
    .join("");
  writeRegistry(
    root,
    "rules",
    `
schemaVersion: 1
promotionRequirements:
  investigation:
    requireReferenceDoc: true
    requireEcosystemCheck: true
    requireClaudeAdvisoryKickoff: true
  stable:
    minIndependentRepositories: 2
    requireReplicationsNotIntroducedForTest: true
    maxKnownFalsePositives: 0
    maxKnownFalseNegatives: 0
    productionConcerns: none
    requireClaudeAdvisoryReview: true
    requireRealCorpusInventory: true
statuses:
  ready: Ready.
${semanticFactKindSections()}
rules:
${rules}
${lockedRuleSections(root)}
`,
  );
}
