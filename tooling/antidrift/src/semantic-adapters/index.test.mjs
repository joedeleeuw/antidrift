import { describe, expect, it } from "vitest";

import {
  SEMANTIC_ADAPTER_MANIFEST,
  semanticAdapterManifestForAdapterId,
  semanticAdapterManifestForFactAdapterId,
  semanticAdapterManifestForFactKind,
  semanticAdapterManifestForProofBucket,
  semanticAdapterManifestForRule,
} from "./index.mjs";

describe("semantic adapter manifest", () => {
  it("composes adapter contracts with their owned semantic fact contracts", () => {
    expect(SEMANTIC_ADAPTER_MANIFEST).toHaveLength(9);
    expect(
      semanticAdapterManifestForAdapterId("async-control-flow")?.rules,
    ).toContain("antidrift/no-async-array-method");
    expect(semanticAdapterManifestForAdapterId("parse-input")?.rules).toEqual([
      "antidrift/no-unsafe-deserialize",
    ]);
    expect(semanticAdapterManifestForAdapterId("broad-input")?.rules).toContain(
      "antidrift/no-appeasement-cast",
    );
    expect(
      semanticAdapterManifestForAdapterId(
        "react-state",
      )?.semanticFactContracts.map((entry) => entry.factKind),
    ).toEqual([
      "broadSetterCoMutation",
      "resourceLifecycleProof",
      "sourceMemberStateShardCandidate",
    ]);
    expect(
      semanticAdapterManifestForAdapterId(
        "type-owner",
      )?.semanticFactContracts.map((entry) => entry.factKind),
    ).toEqual(["structuralMatch"]);
    expect(semanticAdapterManifestForAdapterId("type-owner")?.rules).toContain(
      "antidrift/no-status-literal-in-type",
    );
    expect(semanticAdapterManifestForAdapterId("tuple-shape")?.rules).toContain(
      "antidrift/no-nullable-positional-tuple",
    );
    expect(semanticAdapterManifestForAdapterId("not-real")).toBeNull();
  });

  it("indexes manifest entries by rule, proof bucket, and semantic fact ownership", () => {
    expect(
      semanticAdapterManifestForRule("antidrift/no-handrolled-resource-lifecycle-cells").map(
        (entry) => entry.id,
      ),
    ).toEqual(["react-state"]);
    expect(
      semanticAdapterManifestForRule("antidrift/no-unsafe-deserialize").map(
        (entry) => entry.id,
      ),
    ).toEqual(["parse-input"]);
    expect(
      semanticAdapterManifestForRule("antidrift/no-async-array-method").map(
        (entry) => entry.id,
      ),
    ).toEqual(["async-control-flow"]);
    expect(
      semanticAdapterManifestForProofBucket("authority-index-ownership").map(
        (entry) => entry.id,
      ),
    ).toEqual(["type-owner"]);
    expect(
      semanticAdapterManifestForRule(
        "antidrift/no-nullable-positional-tuple",
      ).map((entry) => entry.id),
    ).toEqual(["tuple-shape"]);
    expect(
      semanticAdapterManifestForFactKind("structuralMatch").map(
        (entry) => entry.id,
      ),
    ).toEqual(["type-owner"]);
    expect(
      semanticAdapterManifestForFactAdapterId("react-state").map(
        (entry) => entry.id,
      ),
    ).toEqual(["react-state"]);
    expect(semanticAdapterManifestForRule("antidrift/not-real")).toEqual([]);
  });
});
