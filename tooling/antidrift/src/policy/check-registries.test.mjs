import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../eslint-plugin/index.js";
import { checkRegistries } from "./check-registries.mjs";

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

const lockedRetiredRules = [
  "antidrift/no-cycle",
  "antidrift/no-inline-disable-without-ticket",
  "antidrift/no-sdk-direct-use",
  "antidrift/no-explicit-return-type-private-helper",
  "antidrift/no-silent-catch",
  "antidrift/no-thin-typed-factory-wrapper",
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
  const rules = Object.keys(plugin.rules)
    .sort((a, b) => a.localeCompare(b))
    .map(
      (rule) => `  antidrift/${rule}:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
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
    writeValidRulesRegistry(root);

    expect(checkRegistries({ repoRoot: root, report: () => undefined })).toBe(
      true,
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
    const rules = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map(
        (rule) => `  antidrift/${rule}:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
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

  it("requires active rule entries to explain external rule ownership state", () => {
    const root = workspace();
    const rules = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map(
        (rule) => `  antidrift/${rule}:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
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
});
