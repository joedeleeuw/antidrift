import { describe, expect, it } from "vitest";

import {
  ruleStatusEntriesForKind,
  ruleStatusEntriesForProofBucket,
  ruleStatusEntriesForSemanticAdapter,
  ruleStatusEntriesForStatus,
  ruleStatusEntryForId,
  ruleStatusManifest,
  ruleStatusSemanticSummaries,
  ruleStatusSemanticSummaryForId,
} from "./rule-status.mjs";

describe("rule status manifest", () => {
  it("normalizes active, retired, research, and policy-review registry rows", () => {
    const registry = {
      schemaVersion: 1,
      promotionRequirements: {
        stable: { minIndependentRepositories: 2 },
      },
      rules: {
        "antidrift/no-structural-type-fork": {
          status: "ready",
          stable: false,
          signal: "TypeChecker plus authority index",
          solveType: "generated-type-drift",
          proofBuckets: ["authority-index-ownership"],
          corpusRepositories: ["consumer"],
          semanticAdapterStatus: {
            status: "inline-pending",
            reason: "Type owner facts still live inside the rule.",
          },
          external: {
            state: "net-antidrift",
            decision: "own-antidrift",
          },
          nextAction: "Keep owner facts explicit.",
        },
      },
      retiredRules: {
        "antidrift/no-status-triplet-state": {
          status: "retired",
          replacement: "antidrift/no-handrolled-resource-lifecycle-cells",
          reason: "Name groups are inventory only.",
        },
      },
      researchCandidates: {
        "ecosystem/import-cycle": {
          status: "ecosystem-covered",
          signal: "import-graph",
          solveType: "semantic-architecture-drift",
          referenceDoc: "docs/rule-status-registry.md",
          replacement: "import-x/no-cycle",
          reason: "Covered by the shared ESLint config.",
        },
      },
      policyRuleReviews: {
        "agent/require-checks-before-stop": {
          status: "active-custom",
          antidriftRule: "agent/require-checks-before-stop",
          coverage: "Session fact.",
          reason: "Requires command history.",
          nextAction: "Keep in agent-ops.",
        },
      },
    };

    const manifest = ruleStatusManifest(registry);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      promotionRequirements: {
        stable: { minIndependentRepositories: 2 },
      },
    });
    expect(
      manifest.entries.map((entry) => `${entry.kind}:${entry.id}`),
    ).toEqual([
      "active:antidrift/no-structural-type-fork",
      "retired:antidrift/no-status-triplet-state",
      "research:ecosystem/import-cycle",
      "policy-review:agent/require-checks-before-stop",
    ]);
    expect(
      ruleStatusEntryForId("antidrift/no-structural-type-fork", manifest),
    ).toMatchObject({
      kind: "active",
      stable: false,
      proofBuckets: ["authority-index-ownership"],
      semanticAdapterStatus: {
        status: "inline-pending",
        reason: "Type owner facts still live inside the rule.",
      },
      external: {
        decision: "own-antidrift",
      },
    });
    expect(ruleStatusEntriesForStatus("retired", manifest)).toEqual([
      expect.objectContaining({
        id: "antidrift/no-status-triplet-state",
        replacement: "antidrift/no-handrolled-resource-lifecycle-cells",
      }),
    ]);
    expect(ruleStatusEntriesForKind("policy-review", manifest)).toEqual([
      expect.objectContaining({
        id: "agent/require-checks-before-stop",
        coverage: "Session fact.",
      }),
    ]);
    expect(ruleStatusEntryForId("antidrift/not-real", manifest)).toBeNull();
  });

  it("indexes rule status rows by semantic adapter and proof bucket", () => {
    const registry = {
      rules: {
        "antidrift/no-handrolled-resource-lifecycle-cells": { status: "ready" },
        "antidrift/no-raw-fetch-in-component": {
          status: "ready",
          stable: true,
          promotion: { proofBucket: "local-ast-source-shape" },
        },
        "antidrift/no-structural-type-fork": { status: "ready" },
        "antidrift/no-hover-translate-card": {
          status: "ready",
          proofBuckets: ["local-ast-source-shape"],
        },
      },
    };

    expect(
      ruleStatusEntriesForSemanticAdapter("react-state", registry).map(
        (entry) => entry.id,
      ),
    ).toEqual(["antidrift/no-handrolled-resource-lifecycle-cells"]);
    expect(
      ruleStatusEntriesForProofBucket(
        "authority-index-ownership",
        registry,
      ).map((entry) => entry.id),
    ).toEqual(["antidrift/no-structural-type-fork"]);
    expect(
      ruleStatusEntriesForProofBucket("local-ast-source-shape", registry).map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "antidrift/no-hover-translate-card",
      "antidrift/no-raw-fetch-in-component",
    ]);
    expect(ruleStatusEntriesForSemanticAdapter("not-real", registry)).toEqual(
      [],
    );
  });

  it("joins rule status rows to semantic adapters, fact contracts, and proof buckets", () => {
    const registry = {
      rules: {
        "antidrift/no-handrolled-resource-lifecycle-cells": { status: "ready" },
        "antidrift/no-raw-fetch-in-component": {
          status: "ready",
          stable: true,
          promotion: { proofBucket: "local-ast-source-shape" },
        },
        "antidrift/no-structural-type-fork": {
          status: "ready",
          promotion: { proofBucket: "authority-index-ownership" },
        },
        "antidrift/no-hover-translate-card": {
          status: "ready",
          proofBuckets: ["local-ast-source-shape"],
        },
      },
    };

    expect(
      ruleStatusSemanticSummaryForId(
        "antidrift/no-handrolled-resource-lifecycle-cells",
        registry,
      ),
    ).toMatchObject({
      entry: { id: "antidrift/no-handrolled-resource-lifecycle-cells" },
      proofBuckets: ["semantic-source-type-provenance"],
      semanticAdapters: [{ id: "react-state" }],
      semanticFactContracts: [
        { factKind: "broadSetterCoMutation" },
        { factKind: "resourceLifecycleProof" },
        { factKind: "sourceMemberStateShardCandidate" },
      ],
    });
    expect(
      ruleStatusSemanticSummaryForId(
        "antidrift/no-raw-fetch-in-component",
        registry,
      ),
    ).toMatchObject({
      entry: { id: "antidrift/no-raw-fetch-in-component" },
      proofBuckets: ["local-ast-source-shape"],
      semanticAdapters: [],
      semanticFactContracts: [],
    });
    expect(ruleStatusSemanticSummaryForId("antidrift/not-real", registry)).toBe(
      null,
    );
    expect(
      ruleStatusSemanticSummaries(registry).map((summary) => summary.entry.id),
    ).toEqual([
      "antidrift/no-handrolled-resource-lifecycle-cells",
      "antidrift/no-hover-translate-card",
      "antidrift/no-raw-fetch-in-component",
      "antidrift/no-structural-type-fork",
    ]);
  });
});
