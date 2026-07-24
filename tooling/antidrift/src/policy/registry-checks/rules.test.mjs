import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkRegistries } from "../check-registries.mjs";
import {
  lockedRuleSections,
  plugin,
  semanticFactKindSections,
  touch,
  workspace,
  writePolicySource,
  writeRegistry,
  writeValidRulesRegistry,
} from "../../../test/support/registry-workspace.mjs";

describe("rule promotion and policy reviews", () => {
  it("rejects malformed default-off rule metadata", () => {
    const root = workspace();
    const messages = [];
    writeValidRulesRegistry(root);
    const registryPath = join(root, "policy/registries/rules.yaml");
    const source = readFileSync(registryPath, "utf8");
    writeFileSync(
      registryPath,
      source.replace(
        [
          "  antidrift/no-sql-string-concat:",
          "    status: ready",
          "    stable: false",
        ].join("\n"),
        [
          "  antidrift/no-sql-string-concat:",
          "    status: ready",
          "    stable: false",
          "    defaultOff: yes",
        ].join("\n"),
      ),
    );
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-sql-string-concat.defaultOff must be a boolean.",
    );
  });
  it("rejects stable rules marked default-off", () => {
    const root = workspace();
    const messages = [];
    writeValidRulesRegistry(root);
    const registryPath = join(root, "policy/registries/rules.yaml");
    const source = readFileSync(registryPath, "utf8");
    writeFileSync(
      registryPath,
      source.replace(
        [
          "  antidrift/no-sql-string-concat:",
          "    status: ready",
          "    stable: false",
        ].join("\n"),
        [
          "  antidrift/no-sql-string-concat:",
          "    status: ready",
          "    stable: true",
          "    defaultOff: true",
        ].join("\n"),
      ),
    );
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(false);
    expect(messages.join("\n")).toContain(
      "policy/registries/rules.yaml rules.antidrift/no-sql-string-concat.defaultOff must not be true for stable rules.",
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
  it("rejects diff-relative proof buckets in active rule registry rows", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "    proofBuckets: [local-ast-source-shape]\n",
        "    proofBuckets: [diff-relative]\n",
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
      "policy/registries/rules.yaml rules.antidrift/no-appeasement-cast.proofBuckets contains unsupported value 'diff-relative'",
    );
  });
  it("rejects diff-relative proof buckets in stable active rule registry rows", () => {
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
    proofBuckets: [diff-relative]
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
      "policy/registries/rules.yaml rules.antidrift/no-async-array-method.proofBuckets contains unsupported value 'diff-relative'",
    );
  });
  it("accepts diff-relative proof buckets in research candidate rows", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    touch(root, "docs/specs/change-contract-conformance-spine.md");
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "researchCandidates:\n",
        `researchCandidates:
  antidrift/change-contract-conformance:
    status: research
    signal: change-contract command facts over merge-base diff surface
    solveType: diff-scope-creep
    proofBuckets: [diff-relative]
    referenceDoc: docs/specs/change-contract-conformance-spine.md
    nextAction: Keep inventory-only until promotion evidence exists.
`,
      ),
    );
    const messages = [];
    expect(
      checkRegistries({
        repoRoot: root,
        report: (message) => messages.push(message),
      }),
    ).toBe(true);
    expect(messages).toEqual([]);
  });
  it("rejects command-owned proof buckets in unrelated research candidate rows", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "  ecosystem/discriminated-union-exhaustiveness:\n    status: ecosystem-covered\n",
        "  ecosystem/discriminated-union-exhaustiveness:\n    status: ecosystem-covered\n    proofBuckets: [diff-relative]\n",
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
      "policy/registries/rules.yaml researchCandidates.ecosystem/discriminated-union-exhaustiveness.proofBuckets contains command-owned proof bucket 'diff-relative' but no command-owned semantic fact maps to ecosystem/discriminated-union-exhaustiveness.",
    );
  });
  it("rejects unsupported proof buckets in research candidate rows", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        "  ecosystem/discriminated-union-exhaustiveness:\n    status: ecosystem-covered\n",
        "  ecosystem/discriminated-union-exhaustiveness:\n    status: ecosystem-covered\n    proofBuckets: [not-a-proof-bucket]\n",
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
      "policy/registries/rules.yaml researchCandidates.ecosystem/discriminated-union-exhaustiveness.proofBuckets contains unsupported value 'not-a-proof-bucket'",
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
  it("requires unclaimed non-local proof bucket rules to document pending adapter extraction", () => {
    const root = workspace();
    writeValidRulesRegistry(root);
    const existing = join(root, "policy", "registries", "rules.yaml");
    const text = readFileSync(existing, "utf8");
    writeFileSync(
      existing,
      text.replace(
        `  antidrift/no-contract-appeasement-projection:
    status: ready
    stable: false
    signal: test-signal
    solveType: test-solve
    proofBuckets: [local-ast-source-shape]
`,
        `  antidrift/no-contract-appeasement-projection:
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
      "policy/registries/rules.yaml rules.antidrift/no-contract-appeasement-projection.semanticAdapterStatus is required when non-local proof buckets are not claimed by a shipped semantic adapter.",
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
