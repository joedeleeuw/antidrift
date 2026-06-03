import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

function writeValidRulesRegistry(root) {
  const rules = Object.keys(plugin.rules)
    .sort((a, b) => a.localeCompare(b))
    .map((rule) => `  antidrift/${rule}:
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
`)
    .join("");

  writeRegistry(root, "rules", `
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
`);
}

describe("checkRegistries", () => {
  it("accepts valid registry ownership paths", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(join(root, "packages/domain/src/user.ts"), 'export const userStatuses = ["active"] as const;\n');
    writeFileSync(join(root, "packages/domain/src/auth.ts"), 'export const roles = ["admin"] as const;\n');
    touch(root, "packages/gateways/src/aiGateway.ts");
    touch(root, "architecture/approved-dependencies.yaml");
    writeRegistry(root, "domain", `
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
`);
    writeRegistry(root, "gateways", `
approvedGateways:
  ai:
    wrapper: packages/gateways/src/aiGateway.ts
    bannedDirectImports: [openai]
`);
    writeRegistry(root, "dependencies", `
runtimeDependencyPolicy:
  requireApproval: true
  approvalFile: architecture/approved-dependencies.yaml
  bannedVersionSpecifiers: [latest]
`);
    writeValidRulesRegistry(root);

    expect(checkRegistries({ repoRoot: root, report: () => undefined })).toBe(true);
  });

  it("rejects domain registry values that drift from owner exports", () => {
    const root = workspace();
    mkdirSync(join(root, "packages/domain/src"), { recursive: true });
    writeFileSync(join(root, "packages/domain/src/user.ts"), 'export const userStatuses = ["active", "disabled"] as const;\n');
    writeRegistry(root, "domain", `
    statuses:
      UserStatus:
        owner: packages/domain/src/user.ts
        valuesExport: userStatuses
        values: [active]
`);
    writeValidRulesRegistry(root);
    const messages = [];

    expect(checkRegistries({ repoRoot: root, report: (message) => messages.push(message) })).toBe(false);
    expect(messages.join("\n")).toContain("statuses.UserStatus.values must match exported userStatuses");
  });

  it("rejects registry entries that point at missing owner files", () => {
    const root = workspace();
    const messages = [];
    writeRegistry(root, "domain", `
canonicalEntities:
  User: packages/domain/src/user.ts
`);
    writeValidRulesRegistry(root);

    expect(checkRegistries({ repoRoot: root, report: (message) => messages.push(message) })).toBe(false);
    expect(messages.join("\n")).toContain("policy/registries/domain.yaml canonicalEntities.User path does not exist");
  });

  it("requires active rule entries to declare flag and allow examples", () => {
    const root = workspace();
    const rules = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((rule) => `  antidrift/${rule}:
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
`)
      .join("");
    writeRegistry(root, "rules", `
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
`);
    const messages = [];

    expect(checkRegistries({ repoRoot: root, report: (message) => messages.push(message) })).toBe(false);
    expect(messages.join("\n")).toContain(".examples.flags must not be empty");
    expect(messages.join("\n")).toContain(".examples.allows must not be empty");
  });

  it("requires active rule entries to explain external rule ownership state", () => {
    const root = workspace();
    const rules = Object.keys(plugin.rules)
      .sort((a, b) => a.localeCompare(b))
      .map((rule) => `  antidrift/${rule}:
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
`)
      .join("");
    writeRegistry(root, "rules", `
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
`);
    const messages = [];

    expect(checkRegistries({ repoRoot: root, report: (message) => messages.push(message) })).toBe(false);
    expect(messages.join("\n")).toContain(".external.whyThisState must be a non-empty string");
    expect(messages.join("\n")).toContain(".external.whyNotOtherState must be a non-empty string");
  });
});
