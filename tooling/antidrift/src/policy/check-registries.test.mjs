import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkRegistries,
  checkSemanticAdapterContracts,
} from "./check-registries.mjs";
import { SEMANTIC_FACT_KINDS } from "./lib/semantic-facts.mjs";
import plugin from "../eslint-plugin/index.js";
import { SEMANTIC_ADAPTER_CONTRACTS } from "../semantic-adapters/index.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "antidrift-registries-"));
  mkdirSync(join(root, "policy", "registries"), { recursive: true });
  return root;
}

function writeRegistry(root, name, text) {
  writeFileSync(join(root, "policy", "registries", `${name}.yaml`), text);
}

function touch(root, file) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), "");
}

function writePolicySource(root, ruleIds) {
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

function writePackageJson(root, contents) {
  mkdirSync(join(root, "tooling", "antidrift"), { recursive: true });
  writeFileSync(
    join(root, "tooling", "antidrift", "package.json"),
    `${JSON.stringify(contents, null, 2)}\n`,
  );
}

function semanticAdapterPackageExports() {
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

function semanticAdapterContractKeys() {
  return Object.keys(SEMANTIC_ADAPTER_CONTRACTS).sort((a, b) =>
    a.localeCompare(b),
  );
}

function semanticAdapterAggregateRuntimeSource(keys = semanticAdapterContractKeys()) {
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

function semanticAdapterAggregateTypeSource(keys = semanticAdapterContractKeys()) {
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

function writeSemanticAdapterAggregateFiles(root) {
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

function touchSemanticAdapterPackageExportFiles(root) {
  writeSemanticAdapterAggregateFiles(root);
  for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.d.mts`);
    touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.mjs`);
  }
}

function yamlFlowStrings(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function replaceMarkdownRowCell(text, rowName, cellIndex, value) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes(`| \`${rowName}\` |`)) return line;
      const cells = line.split("|");
      cells[cellIndex] = ` ${value} `;
      return cells.join("|");
    })
    .join("\n");
}

function replaceYamlSectionField(text, sectionName, fieldName, value) {
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

function semanticFactKindSections() {
  const entries = Object.entries(SEMANTIC_FACT_KINDS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([factKind, contract]) => `  ${factKind}:
    rules: ${yamlFlowStrings(contract.rules)}
    adapterId: ${contract.adapterId}
    carrier: ${contract.carrier}
    confidence: ${yamlFlowStrings(contract.confidence)}
    emission: ${yamlFlowStrings(contract.emission)}
    association: ${JSON.stringify(contract.association)}
    noSinkBehavior: ${JSON.stringify(contract.noSinkBehavior)}
    payloadFields: ${yamlFlowStrings(contract.payloadFields)}
`,
    )
    .join("");

  return `semanticFactKinds:
${entries}`;
}

function activeRuleIds() {
  return Object.keys(plugin.rules)
    .sort((a, b) => a.localeCompare(b))
    .map((rule) => `antidrift/${rule}`);
}

function semanticAdapterContractsForRuleId(rule) {
  return Object.values(SEMANTIC_ADAPTER_CONTRACTS).filter((contract) =>
    contract.rules.includes(rule),
  );
}

function semanticValidationMatrixCarrier(rule) {
  const contracts = semanticAdapterContractsForRuleId(rule);
  if (contracts.length === 0) return "Test carrier.";
  return contracts.map((contract) => contract.carrier).join("; ");
}

function semanticValidationMatrixAssociation(rule) {
  const associations = semanticAdapterContractsForRuleId(rule).flatMap(
    (contract) => contract.associations,
  );
  if (associations.length === 0) return "Test association.";
  return associations.join("; ");
}

function writeValidSemanticValidationMatrix(root) {
  mkdirSync(join(root, "docs"), { recursive: true });
  const rows = activeRuleIds()
    .map(
      (rule) =>
        `| \`${rule}\` | ${semanticValidationMatrixCarrier(rule)} | ${semanticValidationMatrixAssociation(rule)} | Test threshold. | Test validation. | Test missing-data behavior. |`,
    )
    .join("\n");
  writeFileSync(
    join(root, "docs", "semantic-validation-matrix.md"),
    `
# Semantic Validation Matrix

| Rule or candidate | Carrier | Semantic association or authority fact | Blocking threshold | Validation and gap | No-sink or no-dead-work behavior |
| ----------------- | ------- | -------------------------------------- | ------------------ | ------------------ | -------------------------------- |
${rows}
`,
  );
}

function writeValidRealCorpusValidation(root) {
  mkdirSync(join(root, "docs"), { recursive: true });
  const rows = activeRuleIds()
    .map((rule) => `| \`${rule}\` | ready | Test real-source evidence. |`)
    .join("\n");
  writeFileSync(
    join(root, "docs", "real-corpus-validation.md"),
    `
# Real Corpus Validation

| Rule | Status | Real-source evidence |
| ---- | ------ | -------------------- |
${rows}
`,
  );
}

const lockedRetiredRules = [
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

const lockedEcosystemCandidates = [
  "ecosystem/discriminated-union-exhaustiveness",
  "ecosystem/import-cycle",
  "ecosystem/disable-comment-description",
  "ecosystem/gateway-restricted-imports",
  "ecosystem/vitest-test-integrity",
  "ecosystem/react-hooks-compiler",
  "ecosystem/sonar-sql-queries",
];

function lockedRuleSections(root) {
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
  const decisionLocks = [
    ...lockedRetiredRules.map((rule) => [rule, "retired", "retiredRules"]),
    ...lockedEcosystemCandidates.map((rule) => [
      rule,
      "ecosystem-covered",
      "researchCandidates",
    ]),
  ]
    .map(
      ([rule, status, location]) => `  ${rule}:
    status: ${status}
    location: ${location}
    replacement: Test replacement.
    reason: Test locked decision.
`,
    )
    .join("");

  return `
retiredRules:
${retiredRules}
researchCandidates:
${researchCandidates}
decisionLocks:
${decisionLocks}
`;
}

function writeValidRulesRegistry(root) {
  touch(root, "docs/rule-roadmap.md");
  writeValidSemanticValidationMatrix(root);
  writeValidRealCorpusValidation(root);
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

describe("checkRegistries", () => {
  it("accepts valid registry ownership paths", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(
      join(root, "packages/domain/src/user.ts"),
      'export const userStatuses = ["active"] as const;\n',
    );
    writeFileSync(
      join(root, "packages/domain/src/auth.ts"),
      'export const roles = ["admin"] as const;\n',
    );
    touch(root, "packages/gateways/src/aiGateway.ts");
    touch(root, "architecture/approved-dependencies.yaml");
    writeRegistry(
      root,
      "domain",
      `
canonicalEntities:
  User: packages/domain/src/user.ts
statuses:
  UserStatus:
    owner: packages/domain/src/user.ts
    valuesExport: userStatuses
    values: [active]
roles:
  owner: packages/domain/src/auth.ts
  valuesExport: roles
  values: [admin]
`,
    );
    writeRegistry(
      root,
      "gateways",
      `
approvedGateways:
  ai:
    wrapper: packages/gateways/src/aiGateway.ts
    bannedDirectImports: [openai]
`,
    );
    writeRegistry(
      root,
      "dependencies",
      `
runtimeDependencyPolicy:
  requireApproval: true
  approvalFile: architecture/approved-dependencies.yaml
  bannedVersionSpecifiers: [latest]
`,
    );
    writeRegistry(
      root,
      "ownership",
      `
packageTypeOwners:
  firebaseAuthUser:
    package: "@firebase/auth"
    exportName: User
    reason: Firebase Auth User is the accepted auth user contract.
`,
    );
    writeValidRulesRegistry(root);

    expect(checkRegistries({ repoRoot: root, report: () => undefined })).toBe(
      true,
    );
  });

  it("rejects malformed package owner facts", () => {
    const root = workspace();
    const messages = [];
    writeRegistry(
      root,
      "ownership",
      `
packageTypeOwners:
  firebaseAuthUser:
    package: "@firebase/auth"
`,
    );
    writeValidRulesRegistry(root);

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "packageTypeOwners.firebaseAuthUser.exportName must be a non-empty string",
    );
    expect(messages.join("\n")).toContain(
      "packageTypeOwners.firebaseAuthUser.reason must be a non-empty string",
    );
  });

  it("rejects domain registry values that drift from owner exports", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(
      join(root, "packages/domain/src/user.ts"),
      'export const userStatuses = ["active", "disabled"] as const;\n',
    );
    writeRegistry(
      root,
      "domain",
      `
    statuses:
      UserStatus:
        owner: packages/domain/src/user.ts
        valuesExport: userStatuses
        values: [active]
`,
    );
    writeValidRulesRegistry(root);
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "statuses.UserStatus.values must match exported userStatuses",
    );
  });

  it("rejects registry entries that point at missing owner files", () => {
    const root = workspace();
    const messages = [];
    writeRegistry(
      root,
      "domain",
      `
canonicalEntities:
  User: packages/domain/src/user.ts
`,
    );
    writeValidRulesRegistry(root);

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/domain.yaml canonicalEntities.User path does not exist",
    );
  });

  it("requires active rule entries to declare flag and allow examples", () => {
    const root = workspace();
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
    concerns: []
    external:
      state: net-antidrift
      support: none
      candidates: []
      decision: own-antidrift
      whyThisState: No supported equivalent is declared in this synthetic registry.
      whyNotOtherState: Not ecosystem-covered because no upstream rule candidate is listed.
    examples:
      flags: []
      allows: []
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
rules:
${rules}
${lockedRuleSections(root)}
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(".examples.flags must not be empty");
    expect(messages.join("\n")).toContain(".examples.allows must not be empty");
  });

  it("requires non-stable active rule entries to declare proof buckets", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace("    proofBuckets: [local-ast-source-shape]\n", ""),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-appeasement-cast.proofBuckets must be an array of strings.",
    );
  });

  it("requires the semantic validation matrix document", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    rmSync(join(root, "docs", "semantic-validation-matrix.md"));
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md must exist and contain active rule proof rows.",
    );
  });

  it("requires semantic validation matrix rows for active rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "semantic-validation-matrix.md"),
      `
# Semantic Validation Matrix

| Rule |
| ---- |
| \`antidrift/no-appeasement-cast\` |
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md missing active rule row: antidrift/no-async-array-method",
    );
  });

  it("requires semantic validation matrix rows to declare proof details", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    const incompleteRule = "antidrift/no-async-array-method";
    const rows = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((ruleName) => {
        const rule = `antidrift/${ruleName}`;
        if (rule === incompleteRule) {
          return `| \`${rule}\` |  | Test association. | Test threshold. | Test validation. |`;
        }
        return `| \`${rule}\` | Test carrier. | Test association. | Test threshold. | Test validation. |`;
      })
      .join("\n");
    writeFileSync(
      join(root, "docs", "semantic-validation-matrix.md"),
      `
# Semantic Validation Matrix

| Rule or candidate | Carrier | Semantic association or authority fact | Blocking threshold | Validation and gap |
| ----------------- | ------- | -------------------------------------- | ------------------ | ------------------ |
${rows}
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method must declare carrier, semantic association or authority fact, blocking threshold, and validation and gap.",
    );
  });

  it("requires semantic validation matrix rows to declare no-sink or no-dead-work behavior", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    const incompleteRule = "antidrift/no-async-array-method";
    const rows = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((ruleName) => {
        const rule = `antidrift/${ruleName}`;
        if (rule === incompleteRule) {
          return `| \`${rule}\` | Test carrier. | Test association. | Test threshold. | Test validation. |  |`;
        }
        return `| \`${rule}\` | Test carrier. | Test association. | Test threshold. | Test validation. | Test missing-data behavior. |`;
      })
      .join("\n");
    writeFileSync(
      join(root, "docs", "semantic-validation-matrix.md"),
      `
# Semantic Validation Matrix

| Rule or candidate | Carrier | Semantic association or authority fact | Blocking threshold | Validation and gap | No-sink or no-dead-work behavior |
| ----------------- | ------- | -------------------------------------- | ------------------ | ------------------ | -------------------------------- |
${rows}
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method must declare no-sink or no-dead-work behavior.",
    );
  });

  it("requires semantic validation matrix carrier cells to match shipped adapter contracts", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    const text = readFileSync(matrix, "utf8");
    writeFileSync(
      matrix,
      replaceMarkdownRowCell(
        text,
        "antidrift/no-handrolled-resource-lifecycle-cells",
        2,
        "Wrong carrier",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-handrolled-resource-lifecycle-cells carrier must include shipped semantic adapter carrier: React state graph semantic adapter.",
    );
  });

  it("requires semantic validation matrix association cells to match shipped adapter contracts", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    const text = readFileSync(matrix, "utf8");
    writeFileSync(
      matrix,
      replaceMarkdownRowCell(
        text,
        "antidrift/no-handrolled-resource-lifecycle-cells",
        3,
        "Wrong association",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-handrolled-resource-lifecycle-cells association must include one shipped semantic adapter association: React state setter to cell; source object member to state cell; state cell to resource lifecycle role.",
    );
  });

  it("requires semantic validation matrix rows for stable rules to include the promotion association", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: semantic-source-type-provenance
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready |",
        "| `antidrift/no-async-array-method` | ready/stable |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| )[^|]+/u,
        "$1map or flatMap promise collection to later Promise combinator consumption ",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method association must include stable promotion association: async array callback to collection method semantics.",
    );
  });

  it("requires semantic validation matrix rows for stable rules to include the promotion blocking threshold", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: semantic-source-type-provenance
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Test corpus evidence. |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| )[^|]+/u,
        "$1Different threshold. ",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method blocking threshold must include stable promotion blockingThreshold: Test threshold.",
    );
  });

  it("requires semantic validation matrix rows for stable rules to include promotion sink behavior", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: semantic-source-type-provenance
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Test corpus evidence. |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| )[^|]+/u,
        "$1Different sink behavior. ",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method no-sink/no-dead-work behavior must include stable promotion noSinkBehavior: Test no-sink behavior.",
    );
    expect(messages.join("\n")).toContain(
      "docs/semantic-validation-matrix.md row for antidrift/no-async-array-method no-sink/no-dead-work behavior must include stable promotion noDeadWorkBehavior: Test no-dead-work behavior.",
    );
  });

  it("requires stable promotion inventory rows to include the promotion ecosystem comparison", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Test corpus evidence. |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| )[^|]+(\|)/u,
        "$1Test threshold. $2",
      ),
    );
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| )[^|]+/u,
        "$1Test no-sink behavior. Test no-dead-work behavior. ",
      ),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "stable-promotion-inventory.md"),
      `
# Stable Promotion Inventory

| Rank | Rule | Promotion bucket | Utility lens | Drift repos | Clean repos | Why |
| ---: | ---- | ---------------- | ------------ | ----------- | ----------- | --- |
| 1 | \`antidrift/no-async-array-method\` | stable | monitor | repo-one, repo-two | repo-one | Different ecosystem note. |
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/stable-promotion-inventory.md row for antidrift/no-async-array-method why must include stable promotion ecosystemComparison: Test ecosystem comparison.",
    );
  });

  it("requires stable promotion inventory rows to include registry corpus repositories", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Test corpus evidence. |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| )[^|]+(\|)/u,
        "$1Test threshold. $2",
      ),
    );
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| )[^|]+/u,
        "$1Test no-sink behavior. Test no-dead-work behavior. ",
      ),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "stable-promotion-inventory.md"),
      `
# Stable Promotion Inventory

| Rank | Rule | Promotion bucket | Utility lens | Drift repos | Clean repos | Why |
| ---: | ---- | ---------------- | ------------ | ----------- | ----------- | --- |
| 1 | \`antidrift/no-async-array-method\` | stable | monitor | repo-one | repo-one | Test ecosystem comparison. |
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/stable-promotion-inventory.md row for antidrift/no-async-array-method must mention registry corpus repository: repo-two.",
    );
  });

  it("requires stable promotion inventory rows for stable rules to use the stable bucket", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const registry = join(root, "policy", "registries", "rules.yaml");
    const registryText = readFileSync(registry, "utf8");
    writeFileSync(
      registry,
      registryText.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Test corpus evidence. |",
      ),
    );
    const matrix = join(root, "docs", "semantic-validation-matrix.md");
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| )[^|]+(\|)/u,
        "$1Test threshold. $2",
      ),
    );
    writeFileSync(
      matrix,
      readFileSync(matrix, "utf8").replace(
        /(\| `antidrift\/no-async-array-method` \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| )[^|]+/u,
        "$1Test no-sink behavior. Test no-dead-work behavior. ",
      ),
    );
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "stable-promotion-inventory.md"),
      `
# Stable Promotion Inventory

| Rank | Rule | Promotion bucket | Utility lens | Drift repos | Clean repos | Why |
| ---: | ---- | ---------------- | ------------ | ----------- | ----------- | --- |
| 1 | \`antidrift/no-async-array-method\` | needs drift replication | monitor | repo-one, repo-two | repo-one | Test ecosystem comparison. |
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/stable-promotion-inventory.md row for antidrift/no-async-array-method promotion bucket must be stable because policy/registries/rules.yaml stable is true.",
    );
  });

  it("requires the real corpus validation document", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    rmSync(join(root, "docs", "real-corpus-validation.md"));
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md must exist and contain active rule corpus evidence rows.",
    );
  });

  it("requires real corpus validation rows for active rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "real-corpus-validation.md"),
      `
# Real Corpus Validation

| Rule | Status | Real-source evidence |
| ---- | ------ | -------------------- |
| \`antidrift/no-appeasement-cast\` | ready | Test evidence. |
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md missing active rule row: antidrift/no-async-array-method",
    );
  });

  it("requires real corpus validation rows to declare status and evidence", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    const incompleteRule = "antidrift/no-async-array-method";
    const rows = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((ruleName) => {
        const rule = `antidrift/${ruleName}`;
        if (rule === incompleteRule) {
          return `| \`${rule}\` | ready |  |`;
        }
        return `| \`${rule}\` | ready | Test real-source evidence. |`;
      })
      .join("\n");
    writeFileSync(
      join(root, "docs", "real-corpus-validation.md"),
      `
# Real Corpus Validation

| Rule | Status | Real-source evidence |
| ---- | ------ | -------------------- |
${rows}
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md row for antidrift/no-async-array-method must declare status and real-source evidence.",
    );
  });

  it("rejects real corpus validation rows that claim stable for non-stable registry rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const ledger = join(root, "docs", "real-corpus-validation.md");
    const text = readFileSync(ledger, "utf8");
    writeFileSync(
      ledger,
      text.replace(
        "| `antidrift/no-async-array-method` | ready |",
        "| `antidrift/no-async-array-method` | ready/stable |",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md row for antidrift/no-async-array-method status must not claim stable when policy/registries/rules.yaml stable is false.",
    );
  });

  it("requires real corpus validation rows to include the registry status for non-stable rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const ledger = join(root, "docs", "real-corpus-validation.md");
    const text = readFileSync(ledger, "utf8");
    writeFileSync(
      ledger,
      text.replace(
        "| `antidrift/no-async-array-method` | ready |",
        "| `antidrift/no-async-array-method` | under-proven |",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md row for antidrift/no-async-array-method status must include registry status 'ready'.",
    );
  });

  it("requires real corpus validation rows to mark registry-stable rules as stable", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md row for antidrift/no-async-array-method status must include stable because policy/registries/rules.yaml stable is true.",
    );
  });

  it("requires real corpus validation rows for stable rules to include the promotion corpus evidence", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: async array callback to collection method semantics
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const ledger = join(root, "docs", "real-corpus-validation.md");
    writeFileSync(
      ledger,
      readFileSync(ledger, "utf8").replace(
        "| `antidrift/no-async-array-method` | ready | Test real-source evidence. |",
        "| `antidrift/no-async-array-method` | ready/stable | Different evidence. |",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "docs/real-corpus-validation.md row for antidrift/no-async-array-method evidence must include stable promotion corpusEvidence: Test corpus evidence.",
    );
  });

  it("requires active rule entries to explain external rule ownership state", () => {
    const root = workspace();
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
    concerns: []
    external:
      state: net-antidrift
      support: none
      candidates: []
      decision: own-antidrift
      whyThisState: ''
      whyNotOtherState: ''
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
rules:
${rules}
${lockedRuleSections(root)}
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      ".external.whyThisState must be a non-empty string",
    );
    expect(messages.join("\n")).toContain(
      ".external.whyNotOtherState must be a non-empty string",
    );
  });

  it("requires active rule entries to document a reference investigation", () => {
    const root = workspace();
    touch(root, "docs/rule-roadmap.md");
    const rules = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((rule) => {
        const referenceDoc =
          rule === "no-async-array-method"
            ? ""
            : "    referenceDoc: docs/rule-roadmap.md\n";
        return `  antidrift/${rule}:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
${referenceDoc}    corpusRepositories: []
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
`;
      })
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
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.referenceDoc must be a non-empty string.",
    );
  });

  it("rejects rule-family subsets that reference unknown rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
ruleFamilies:
  type-contract-authority:
    description: Owns type authority laundering patterns.
    subsets:
      casts:
        intent: Reject type escape hatches.
        rules: [antidrift/not-a-rule]
        flags:
          - raw as Order
        allows:
          - OrderSchema.parse(raw)
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "ruleFamilies.type-contract-authority.subsets.casts.rules references unknown rule: antidrift/not-a-rule",
    );
  });

  it("rejects locked retired decisions when they are reactivated", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "rules:\n",
        `rules:
  antidrift/no-cycle:
    status: ready
    stable: false
    signal: import-graph
    solveType: architecture-cycle
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
    concerns: []
    external:
      state: equivalent
      support: high
      candidates: [import-x/no-cycle]
      decision: own-antidrift
      whyThisState: Bad test state.
      whyNotOtherState: Bad test state.
    examples:
      flags:
        - cycle()
      allows:
        - acyclic()
    nextAction: Bad test action.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "rules must not reactivate locked decision: antidrift/no-cycle",
    );
  });

  it("rejects removed decision locks even when the retired entry remains", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8").replace(
      / {2}antidrift\/no-silent-catch:\n {4}status: retired\n {4}location: retiredRules\n {4}replacement: Test replacement\.\n {4}reason: Test locked decision\.\n/u,
      "",
    );
    writeFileSync(existing, text);
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "decisionLocks missing locked decision: antidrift/no-silent-catch",
    );
  });

  it("requires locked retired package replacements to match their reference docs", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "no-status-triplet-state.md"),
      "The replacement is `antidrift/no-coupled-state-setters`.\n",
    );
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8")
      .replace(
        `  antidrift/no-status-triplet-state:
    status: retired
    reason: Test retired decision.
`,
        `  antidrift/no-status-triplet-state:
    status: retired
    reason: Test retired decision.
    referenceDoc: docs/no-status-triplet-state.md
`,
      )
      .replace(
        / {2}antidrift\/no-status-triplet-state:\n {4}status: retired\n {4}location: retiredRules\n {4}replacement: Test replacement\.\n {4}reason: Test locked decision\.\n/u,
        `  antidrift/no-status-triplet-state:
    status: retired
    location: retiredRules
    replacement: antidrift/no-handrolled-resource-lifecycle-cells
    reason: Test locked decision.
`,
      );
    writeFileSync(existing, text);
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "policy/registries/rules.yaml retiredRules.antidrift/no-status-triplet-state.referenceDoc must mention decisionLocks replacement antidrift/no-handrolled-resource-lifecycle-cells.",
    );
    expect(output).toContain(
      "docs/no-status-triplet-state.md references unknown package rule antidrift/no-coupled-state-setters from retired decision antidrift/no-status-triplet-state.",
    );
  });

  it("rejects locked decisions in non-historical rule-family subsets", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
ruleFamilies:
  architecture:
    description: Owns active architecture rules.
    subsets:
      cycles:
        intent: Reject import cycles.
        rules: [ecosystem/import-cycle]
        flags:
          - import cycle
        allows:
          - acyclic imports
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "ruleFamilies.architecture.subsets.cycles.historical must be true when referencing locked decisions: ecosystem/import-cycle",
    );
  });

  it("requires emitted semantic fact kinds to be registered", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    mkdirSync(join(root, "tooling/antidrift/src/eslint-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tooling/antidrift/src/eslint-plugin/index.js"),
      'emitSemanticFact(context, node, { factKind: "missingFact" });\n',
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "semanticFactKinds missing emitted fact kind: missingFact",
    );
  });

  it("requires shipped semantic fact contracts to be registered", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8").replace(
      /\nsemanticFactKinds:\n(?: {2}[^\n]+:\n(?: {4}[^\n]*\n)+)+/u,
      "\n",
    );
    writeFileSync(existing, text);
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "semanticFactKinds is required because the package ships semantic fact contracts",
    );
  });

  it("rejects malformed semantic fact kind declarations", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "\nrules:\n",
        `
  badFact:
    rules: [antidrift/not-real]
    adapterId: test-adapter
    carrier: made-up-carrier
    confidence: [wishful-thinking]
    emission: [silent-blocking]
    association: Bad test association.
    noSinkBehavior: Bad test behavior.
    payloadFields: [thing]
rules:
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "semanticFactKinds.badFact.rules references unknown active rule: antidrift/not-real",
    );
    expect(output).toContain(
      "semanticFactKinds.badFact.carrier must be one of",
    );
    expect(output).toContain(
      "semanticFactKinds.badFact.confidence contains unsupported value 'wishful-thinking'",
    );
    expect(output).toContain(
      "semanticFactKinds.badFact.emission contains unsupported value 'silent-blocking'",
    );
    expect(output).toContain(
      "semanticFactKinds contains non-shipped semantic fact contract: badFact",
    );
  });

  it("rejects model-assisted semantic facts that claim blocking enforcement", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "\nrules:\n",
        `
  modelSuggestion:
    rules: [antidrift/no-handrolled-resource-lifecycle-cells]
    adapterId: test-model
    carrier: model-assisted
    confidence: [model-suggestion]
    emission: [blocking-diagnostic]
    association: Model cluster to candidate semantic drift.
    noSinkBehavior: No fact is emitted and no diagnostic is produced.
    payloadFields: [candidate]
rules:
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "semanticFactKinds.modelSuggestion.emission must not include blocking-diagnostic when carrier is model-assisted.",
    );
  });

  it("rejects semantic fact kind declarations that drift from the shipped package contract", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      replaceYamlSectionField(
        text,
        "resourceLifecycleProof",
        "adapterId",
        "wrong-adapter",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "semanticFactKinds.resourceLifecycleProof.adapterId must match the shipped semantic fact contract (react-state).",
    );
  });

  it("rejects semantic fact kind declarations whose association metadata drifts from the shipped package contract", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      replaceYamlSectionField(
        replaceYamlSectionField(
          text,
          "broadSetterCoMutation",
          "association",
          "Wrong semantic association.",
        ),
        "broadSetterCoMutation",
        "noSinkBehavior",
        "Wrong no-sink behavior.",
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "semanticFactKinds.broadSetterCoMutation.association must match the shipped semantic fact contract",
    );
    expect(output).toContain(
      "semanticFactKinds.broadSetterCoMutation.noSinkBehavior must match the shipped semantic fact contract",
    );
  });

  it("rejects semantic adapter contracts that drift from shipped adapters and active rules", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        reactState: {
          id: "react-state",
          exportName: "wrongExport",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
          rules: ["antidrift/not-real"],
          proofBuckets: ["not-a-proof-bucket"],
          semanticFactAdapterIds: [""],
          semanticFactKinds: [""],
          associations: [],
          carrier: "",
        },
        staleAdapter: {
          id: "stale-adapter",
          exportName: "staleAdapter",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/stale-adapter",
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["stale adapter association"],
          carrier: "AST",
        },
      },
      {
        reactState: {},
        sql: {},
      },
      new Set(["antidrift/no-handrolled-resource-lifecycle-cells"]),
      messages,
      "test semantic adapter contracts",
    );

    const output = messages.join("\n");
    expect(output).toContain(
      "test semantic adapter contracts missing contract for shipped adapter: sql",
    );
    expect(output).toContain(
      "test semantic adapter contracts contains contract for non-exported adapter: staleAdapter",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.exportName must match its contract key (reactState).",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.rules references unknown active rule: antidrift/not-real",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.proofBuckets contains unsupported value 'not-a-proof-bucket'",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.semanticFactAdapterIds must be an array of strings.",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.semanticFactKinds must be an array of strings.",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.associations must not be empty.",
    );
    expect(output).toContain(
      "test semantic adapter contracts.reactState.carrier must be a non-empty string.",
    );
  });

  it("rejects semantic adapter contracts without an exported adapter module", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        reactState: {
          id: "react-state",
          exportName: "reactState",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["React state setter to cell"],
          carrier: "React state graph semantic adapter",
        },
      },
      { reactState: null },
      new Set(["antidrift/no-handrolled-resource-lifecycle-cells"]),
      messages,
      "test semantic adapter contracts",
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.reactState exported adapter must be a mapping.",
    );
  });

  it("rejects semantic adapter contracts with empty exported adapter modules", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        reactState: {
          id: "react-state",
          exportName: "reactState",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["React state setter to cell"],
          carrier: "React state graph semantic adapter",
        },
      },
      { reactState: {} },
      new Set(["antidrift/no-handrolled-resource-lifecycle-cells"]),
      messages,
      "test semantic adapter contracts",
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.reactState exported adapter must expose at least one runtime primitive.",
    );
  });

  it("rejects stable semantic adapter rules whose promotion proof bucket is not declared by the adapter contract", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        schemaProvenance: {
          id: "schema-provenance",
          exportName: "schemaProvenance",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/schema-provenance",
          rules: ["antidrift/no-redundant-zod-parse"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["parsed value to schema provenance"],
          carrier: "TypeChecker plus schema provenance",
        },
      },
      { schemaProvenance: {} },
      new Set(["antidrift/no-redundant-zod-parse"]),
      messages,
      "test semantic adapter contracts",
      {
        "antidrift/no-redundant-zod-parse": {
          stable: true,
          promotion: { proofBucket: "local-ast-source-shape" },
        },
      },
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.schemaProvenance.proofBuckets must include stable rule antidrift/no-redundant-zod-parse promotion proofBucket (local-ast-source-shape).",
    );
  });

  it("rejects stable semantic adapter rules whose promotion association is not declared by the adapter contract", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        schemaProvenance: {
          id: "schema-provenance",
          exportName: "schemaProvenance",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/schema-provenance",
          rules: ["antidrift/no-redundant-zod-parse"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["parsed value to schema provenance"],
          carrier: "TypeChecker plus schema provenance",
        },
      },
      { schemaProvenance: {} },
      new Set(["antidrift/no-redundant-zod-parse"]),
      messages,
      "test semantic adapter contracts",
      {
        "antidrift/no-redundant-zod-parse": {
          stable: true,
          promotion: {
            proofBucket: "semantic-source-type-provenance",
            association: "Stable same-schema parse association.",
          },
        },
      },
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.schemaProvenance.associations must include stable rule antidrift/no-redundant-zod-parse promotion association.",
    );
  });

  it("rejects stable semantic source rules that are not claimed by a shipped adapter contract", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        schemaProvenance: {
          id: "schema-provenance",
          exportName: "schemaProvenance",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/schema-provenance",
          rules: ["antidrift/no-redundant-zod-parse"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["parsed value to schema provenance"],
          carrier: "TypeChecker plus schema provenance",
        },
      },
      { schemaProvenance: {} },
      new Set([
        "antidrift/no-redundant-zod-parse",
        "antidrift/no-unsafe-deserialize",
      ]),
      messages,
      "test semantic adapter contracts",
      {
        "antidrift/no-redundant-zod-parse": {
          stable: true,
          promotion: { proofBucket: "semantic-source-type-provenance" },
        },
        "antidrift/no-unsafe-deserialize": {
          stable: true,
          promotion: { proofBucket: "semantic-source-type-provenance" },
        },
      },
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts must claim stable semantic-source-type-provenance rule antidrift/no-unsafe-deserialize.",
    );
  });

  it("requires unclaimed non-local proof bucket rules to document pending adapter extraction", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-trivial-selector-wrapper:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
`,
        `  antidrift/no-trivial-selector-wrapper:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [semantic-source-type-provenance]
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-trivial-selector-wrapper.semanticAdapterStatus is required when non-local proof buckets are not claimed by a shipped semantic adapter.",
    );
  });

  it("rejects shipped semantic adapters missing package export subpaths", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        "./semantic-adapters": {
          types: "./src/semantic-adapters/index.d.mts",
          import: "./src/semantic-adapters/index.mjs",
        },
        "./semantic-adapters/auth-boundary": {
          types: "./src/semantic-adapters/auth-boundary.d.mts",
          import: "./src/semantic-adapters/auth-boundary.mjs",
        },
        "./semantic-adapters/broad-input": {
          types: "./src/semantic-adapters/broad-input.d.mts",
          import: "./src/semantic-adapters/broad-input.mjs",
        },
        "./semantic-adapters/react-state": {
          types: "./src/semantic-adapters/react-state.d.mts",
          import: "./src/semantic-adapters/react-state.mjs",
        },
        "./semantic-adapters/schema-provenance": {
          types: "./src/semantic-adapters/schema-provenance.d.mts",
          import: "./src/semantic-adapters/schema-provenance.mjs",
        },
        "./semantic-adapters/sql": {
          types: "./src/semantic-adapters/sql.d.mts",
          import: "./src/semantic-adapters/sql.mjs",
        },
        "./semantic-adapters/type-owner": {
          types: "./src/semantic-adapters/type-owner.d.mts",
          import: "./src/semantic-adapters/type-owner.mjs",
        },
      },
    });
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports missing semantic adapter subpath: ./semantic-adapters/parse-input",
    );
  });

  it("rejects shipped semantic adapter package exports whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touch(root, "tooling/antidrift/src/semantic-adapters/index.d.mts");
    touch(root, "tooling/antidrift/src/semantic-adapters/index.mjs");
    for (const contract of Object.values(SEMANTIC_ADAPTER_CONTRACTS)) {
      if (contract.id === "parse-input") continue;
      touch(
        root,
        `tooling/antidrift/src/semantic-adapters/${contract.id}.d.mts`,
      );
      touch(root, `tooling/antidrift/src/semantic-adapters/${contract.id}.mjs`);
    }
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.import path does not exist: ./src/semantic-adapters/parse-input.mjs",
    );
  });

  it("rejects semantic adapter aggregate runtime surfaces missing contract adapters", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    const keys = semanticAdapterContractKeys().filter(
      (key) => key !== "reactState",
    );
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "semantic-adapters", "index.mjs"),
      semanticAdapterAggregateRuntimeSource(keys),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.mjs missing adapter namespace import: reactState",
    );
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.mjs missing named adapter export: reactState",
    );
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.mjs SEMANTIC_ADAPTERS missing adapter key: reactState",
    );
  });

  it("rejects semantic adapter aggregate type surfaces missing contract adapters", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    const keys = semanticAdapterContractKeys().filter(
      (key) => key !== "reactState",
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
      semanticAdapterAggregateTypeSource(keys),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.d.mts missing adapter namespace import: reactState",
    );
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.d.mts missing named adapter export: reactState",
    );
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.d.mts SEMANTIC_ADAPTERS declaration missing adapter key: reactState",
    );
    expect(output).toContain(
      "tooling/antidrift/src/semantic-adapters/index.d.mts SemanticAdapterContractKey missing adapter key: reactState",
    );
  });

  it("rejects semantic adapter runtime exports missing type declarations", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.mjs",
      ),
      "export function runtimeOnly() {}\n",
    );
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.d.mts",
      ),
      "export function declaredOnly(): void;\n",
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.import runtime export runtimeOnly is missing from types path ./src/semantic-adapters/parse-input.d.mts",
    );
  });

  it("rejects semantic adapter type declarations missing runtime exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, { exports: semanticAdapterPackageExports() });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.mjs",
      ),
      "export function runtimeOnly() {}\n",
    );
    writeFileSync(
      join(
        root,
        "tooling",
        "antidrift",
        "src",
        "semantic-adapters",
        "parse-input.d.mts",
      ),
      [
        "export function runtimeOnly(): void;",
        "export function declaredOnly(): void;",
        "export interface TypeOnlyDeclaration {}",
        "",
      ].join("\n"),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./semantic-adapters/parse-input.types declaration declaredOnly is missing from runtime import path ./src/semantic-adapters/parse-input.mjs",
    );
    expect(messages.join("\n")).not.toContain("TypeOnlyDeclaration");
  });

  it("rejects non-adapter package exports whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        ...semanticAdapterPackageExports(),
        "./policy": {
          types: "./src/policy/index.d.mts",
          import: "./src/policy/missing.mjs",
        },
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    touch(root, "tooling/antidrift/src/policy/index.d.mts");
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./policy.import path does not exist: ./src/policy/missing.mjs",
    );
  });

  it("rejects non-adapter default type declarations missing runtime exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: {
        ...semanticAdapterPackageExports(),
        "./eslint-plugin": {
          types: "./src/eslint-plugin/index.d.ts",
          import: "./src/eslint-plugin/index.js",
        },
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    mkdirSync(join(root, "tooling", "antidrift", "src", "eslint-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "eslint-plugin", "index.js"),
      "export const plugin = {};\n",
    );
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "eslint-plugin", "index.d.ts"),
      "declare const plugin: unknown;\nexport default plugin;\n",
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json exports./eslint-plugin.types declaration default is missing from runtime import path ./src/eslint-plugin/index.js",
    );
  });

  it("rejects package CLI binary targets whose files are missing", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: semanticAdapterPackageExports(),
      bin: {
        antidrift: "src/policy/missing-cli.mjs",
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json bin.antidrift path does not exist: src/policy/missing-cli.mjs",
    );
  });

  it("rejects package CLI binary targets without a Node shebang", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      exports: semanticAdapterPackageExports(),
      bin: {
        antidrift: "src/policy/cli.mjs",
      },
    });
    touchSemanticAdapterPackageExportFiles(root);
    mkdirSync(join(root, "tooling", "antidrift", "src", "policy"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tooling", "antidrift", "src", "policy", "cli.mjs"),
      "console.log('not a direct cli');\n",
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/package.json bin.antidrift must start with #!/usr/bin/env node.",
    );
  });

  it("requires the package README public entry points to mention shipped exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      name: "@joedeleeuw/antidrift",
      exports: semanticAdapterPackageExports(),
    });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(root, "tooling", "antidrift", "README.md"),
      Object.keys(semanticAdapterPackageExports())
        .filter((exportKey) => exportKey !== "./semantic-adapters/parse-input")
        .map((exportKey) =>
          exportKey === "."
            ? "- `@joedeleeuw/antidrift`"
            : `- \`@joedeleeuw/antidrift/${exportKey.slice(2)}\``,
        )
        .join("\n"),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/README.md public entry points missing package export: @joedeleeuw/antidrift/semantic-adapters/parse-input",
    );
  });

  it("rejects stale package README public entry points that are not shipped exports", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    writePackageJson(root, {
      name: "@joedeleeuw/antidrift",
      exports: semanticAdapterPackageExports(),
    });
    touchSemanticAdapterPackageExportFiles(root);
    writeFileSync(
      join(root, "tooling", "antidrift", "README.md"),
      [
        ...Object.keys(semanticAdapterPackageExports()).map((exportKey) =>
          exportKey === "."
            ? "- `@joedeleeuw/antidrift`"
            : `- \`@joedeleeuw/antidrift/${exportKey.slice(2)}\``,
        ),
        "- `@joedeleeuw/antidrift/semantic-adapters/not-real`",
      ].join("\n"),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "tooling/antidrift/README.md public entry points lists non-exported package specifier: @joedeleeuw/antidrift/semantic-adapters/not-real",
    );
  });

  it("rejects shipped semantic facts whose adapter id is not claimed by a matching adapter contract", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        reactState: {
          id: "react-state",
          exportName: "reactState",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: [],
          semanticFactKinds: [],
          associations: ["state cell to resource lifecycle role"],
          carrier: "React state graph semantic adapter",
        },
      },
      { reactState: {} },
      new Set(["antidrift/no-handrolled-resource-lifecycle-cells"]),
      messages,
      "test semantic adapter contracts",
      {},
      {
        resourceLifecycleProof: {
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          adapterId: "react-state",
        },
      },
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.reactState.semanticFactAdapterIds must include shipped semantic fact resourceLifecycleProof adapterId (react-state).",
    );
  });

  it("rejects shipped semantic facts whose fact kind is not claimed by a matching adapter contract", () => {
    const messages = [];
    checkSemanticAdapterContracts(
      {
        reactState: {
          id: "react-state",
          exportName: "reactState",
          subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          proofBuckets: ["semantic-source-type-provenance"],
          semanticFactAdapterIds: ["react-state"],
          semanticFactKinds: [],
          associations: ["state cell to resource lifecycle role"],
          carrier: "React state graph semantic adapter",
        },
      },
      { reactState: {} },
      new Set(["antidrift/no-handrolled-resource-lifecycle-cells"]),
      messages,
      "test semantic adapter contracts",
      {},
      {
        resourceLifecycleProof: {
          rules: ["antidrift/no-handrolled-resource-lifecycle-cells"],
          adapterId: "react-state",
        },
      },
    );

    expect(messages.join("\n")).toContain(
      "test semantic adapter contracts.reactState.semanticFactKinds must include shipped semantic fact kind: resourceLifecycleProof.",
    );
  });

  it("requires promotion metadata for stable active rules", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion must be a mapping for stable rules.",
    );
  });

  it("requires stable active rules to document a reference investigation", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.referenceDoc must be a non-empty string.",
    );
  });

  it("requires stable active rules to be owned by Antidrift instead of delegated externally", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    const ruleHeader = "  antidrift/no-async-array-method:\n";
    const nextRuleHeader = "  antidrift/no-canonical-model-fork:\n";
    const ruleStart = text.indexOf(ruleHeader);
    const nextRuleStart = text.indexOf(nextRuleHeader, ruleStart);
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(nextRuleStart).toBeGreaterThan(ruleStart);
    const ruleBlock = text.slice(ruleStart, nextRuleStart);
    const invalidRuleBlock = ruleBlock
      .replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      )
      .replace(
        `      decision: own-antidrift
      whyThisState: No supported equivalent is declared in this synthetic registry.
      whyNotOtherState: Not ecosystem-covered because no upstream rule candidate is listed.
`,
        `      decision: use-upstream
      whyThisState: Synthetic stable rule delegates to ecosystem support.
      whyNotOtherState: Synthetic stable rule should not use upstream.
`,
      );
    writeFileSync(
      existing,
      `${text.slice(0, ruleStart)}${invalidRuleBlock}${text.slice(nextRuleStart)}`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.external.decision must be own-antidrift for stable active rules.",
    );
  });

  it("requires non-stable active rules to document a blocker and next action", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    const ruleHeader = "  antidrift/no-async-array-method:\n";
    const nextActionLine = "    nextAction: Test action.\n";
    const ruleStart = text.indexOf(ruleHeader);
    const nextActionStart = text.indexOf(nextActionLine, ruleStart);
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(nextActionStart).toBeGreaterThanOrEqual(0);
    const nextActionEnd = nextActionStart + nextActionLine.length;
    const ruleBlock = text.slice(ruleStart, nextActionEnd);
    const invalidRuleBlock = ruleBlock
      .replace(
        `    concerns:
      - Test non-stable blocker.
`,
        "    concerns: []\n",
      )
      .replace(nextActionLine, "");
    writeFileSync(
      existing,
      `${text.slice(0, ruleStart)}${invalidRuleBlock}${text.slice(nextActionEnd)}`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.nextAction must be a non-empty string.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method must document at least one non-stable blocker in concerns, unproven, or openReviewConcerns.",
    );
  });

  it("requires stable active rules to meet the minimum independent repo count", () => {
    const root = workspace();
    touch(root, "docs/test-corpus.md");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/test-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.corpusRepositories must list at least 2 independent repositories for stable promotion.",
    );
  });

  it("requires stable active rules to satisfy configured promotion evidence gates", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.replicationsNotIntroducedForTest must be true for stable promotion.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.knownFalsePositives must be 0 for stable promotion.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.knownFalseNegatives must be 0 for stable promotion.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.productionConcerns must be 'none' for stable promotion.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.claudeAdvisoryReview must be a non-empty string.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.realCorpusInventory must be a non-empty string.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.claudeAdvisoryReviewRefs must be an array of strings.",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.realCorpusInventoryRefs must be an array of strings.",
    );
  });

  it("requires stable promotion evidence references to exist", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [docs/missing-corpus.md]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/missing-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.claudeAdvisoryReviewRefs entry path does not exist: reports/missing-advisory.md",
    );
    expect(output).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.realCorpusInventoryRefs entry path does not exist: docs/missing-corpus.md",
    );
  });

  it("rejects fixture paths as stable real-corpus promotion evidence", () => {
    const root = workspace();
    touch(root, "tooling/antidrift/src/eslint-plugin/fixtures/drift.ts");
    touch(root, "reports/test-advisory.md");
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-async-array-method:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: []
`,
        `  antidrift/no-async-array-method:
    status: ready
    stable: true
    signal: test-signal
    solveType: test-solve
    referenceDoc: docs/rule-roadmap.md
    corpusRepositories: [repo-one, repo-two]
    promotion:
      proofBucket: local-ast-source-shape
      association: Test association.
      blockingThreshold: Test threshold.
      ecosystemComparison: Test ecosystem comparison.
      corpusEvidence: Test corpus evidence.
      realCorpusInventory: Test real corpus inventory.
      realCorpusInventoryRefs: [tooling/antidrift/src/eslint-plugin/fixtures/drift.ts]
      claudeAdvisoryReview: Test advisory review.
      claudeAdvisoryReviewRefs: [reports/test-advisory.md]
      replicationsNotIntroducedForTest: true
      knownFalsePositives: 0
      knownFalseNegatives: 0
      productionConcerns: none
      noSinkBehavior: Test no-sink behavior.
      noDeadWorkBehavior: Test no-dead-work behavior.
`,
      ),
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.promotion.realCorpusInventoryRefs entry must not point at fixture evidence: tooling/antidrift/src/eslint-plugin/fixtures/drift.ts",
    );
  });

  it("requires a review row for every policy-scoped rule", () => {
    const root = workspace();
    writePolicySource(root, ["test/reviewed", "test/missing"]);
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
policyRuleReviews:
  test/reviewed:
    status: spec-only
    coverage: Not implemented in the synthetic policy.
    reason: Reviewed for test.
    nextAction: Leave as documented policy.
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policyRuleReviews missing policy rule review: test/missing",
    );
  });

  it("rejects policy rule reviews that are not in the policy source", () => {
    const root = workspace();
    writePolicySource(root, ["test/reviewed"]);
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
policyRuleReviews:
  test/reviewed:
    status: spec-only
    coverage: Not implemented in the synthetic policy.
    reason: Reviewed for test.
    nextAction: Leave as documented policy.
  test/extra:
    status: spec-only
    coverage: Not implemented in the synthetic policy.
    reason: Reviewed for test.
    nextAction: Leave as documented policy.
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policyRuleReviews contains non-policy rule review: test/extra",
    );
  });

  it("requires active-custom policy reviews to reference active antidrift rules", () => {
    const root = workspace();
    writePolicySource(root, ["test/reviewed"]);
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
policyRuleReviews:
  test/reviewed:
    status: active-custom
    antidriftRule: antidrift/not-real
    coverage: Not implemented in the synthetic policy.
    reason: Reviewed for test.
    nextAction: Leave as documented policy.
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policyRuleReviews.test/reviewed.antidriftRule references unknown active custom rule: antidrift/not-real",
    );
  });

  it("keeps agent-ops policy reviews out of active custom lint status", () => {
    const root = workspace();
    writePolicySource(root, ["agent/require-checks-before-stop"]);
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      `${text}
policyRuleReviews:
  agent/require-checks-before-stop:
    status: active-custom
    antidriftRule: antidrift/require-effect-deps
    coverage: Incorrectly modeled as a custom lint rule.
    reason: Session completion evidence depends on command history.
    nextAction: Move back to hook-covered agent-ops.
`,
    );
    const messages = [];

    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml policyRuleReviews.agent/require-checks-before-stop.status must be hook-covered, policy-script, delegated, spec-only, research, or retired for agent-ops policy rules.",
    );
  });
});
