import { describe, expect, it } from "vitest";

import {
  SEMANTIC_FACT_KINDS,
  SEMANTIC_FACT_KIND_CONTRACT_LIST,
  createJsonlFactSink,
  createMemoryFactSink,
  semanticFact,
  semanticFactKindContractsForAdapterId,
  semanticFactKindContractsForConfidence,
  semanticFactKindContractsForEmission,
  semanticFactKindContractsForRule,
  semanticFactToJsonLine,
} from "./semantic-facts.mjs";

describe("semantic facts", () => {
  it("exports shipped fact kind contracts for consumer tooling", () => {
    expect(
      Object.keys(SEMANTIC_FACT_KINDS).sort((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      "broadSetterCoMutation",
      "resourceLifecycleProof",
      "structuralMatch",
    ]);
    expect(SEMANTIC_FACT_KINDS.structuralMatch).toMatchObject({
      adapterId: "typescript-eslint/type-owner",
      carrier: "authority-registry",
      association:
        "Local handwritten object contracts to accepted or proposed generated, domain, or package owner types.",
      noSinkBehavior:
        "Accepted generated, domain, and package owner diagnostics still report; unaccepted installed-package owner proposals are not collected.",
      rules: [
        "antidrift/no-canonical-model-fork",
        "antidrift/no-structural-type-fork",
      ],
    });
    expect(SEMANTIC_FACT_KINDS.structuralMatch.payloadFields).toContain(
      "ownerType",
    );
  });

  it("indexes semantic fact contracts by owning adapter and rule", () => {
    expect(
      SEMANTIC_FACT_KIND_CONTRACT_LIST.map((entry) => entry.factKind).sort(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual([
      "broadSetterCoMutation",
      "resourceLifecycleProof",
      "structuralMatch",
    ]);
    expect(
      semanticFactKindContractsForAdapterId("react-state").map(
        (entry) => entry.factKind,
      ),
    ).toEqual(["broadSetterCoMutation", "resourceLifecycleProof"]);
    expect(
      semanticFactKindContractsForRule(
        "antidrift/no-handrolled-resource-lifecycle-cells",
      ).map((entry) => entry.factKind),
    ).toEqual(["broadSetterCoMutation", "resourceLifecycleProof"]);
    expect(semanticFactKindContractsForAdapterId("not-real")).toEqual([]);
  });

  it("indexes semantic fact contracts by emission and confidence", () => {
    expect(
      semanticFactKindContractsForEmission("inventory-only").map(
        (entry) => entry.factKind,
      ),
    ).toEqual(["broadSetterCoMutation"]);
    expect(
      semanticFactKindContractsForEmission("blocking-diagnostic").map(
        (entry) => entry.factKind,
      ),
    ).toEqual(["resourceLifecycleProof", "structuralMatch"]);
    expect(
      semanticFactKindContractsForConfidence("deterministic-enforcement").map(
        (entry) => entry.factKind,
      ),
    ).toEqual(["resourceLifecycleProof", "structuralMatch"]);
    expect(semanticFactKindContractsForEmission("not-real")).toEqual([]);
  });

  it("normalizes deterministic facts with stable ids and evidence hashes", () => {
    const input = {
      factKind: "structuralMatch",
      ruleId: "antidrift/no-structural-type-fork",
      adapterId: "typescript-eslint/type-owner",
      confidence: "deterministic-enforcement",
      provenance: ["AST", "TypeChecker"],
      filePath: "src/user.ts",
      location: { line: 1, column: 0 },
      payload: {
        astNode: { type: "TSTypeAliasDeclaration" },
        localType: {
          name: "AuthUser",
          props: [["uid", "string"]],
        },
        modelScore: 0.99,
        node: { type: "TSInterfaceDeclaration" },
        ownerType: {
          label: "firebase/auth#UserInfo",
          props: [["uid", "string"]],
        },
        tsProgram: { sourceFiles: [] },
      },
    };

    const first = semanticFact(input);
    const second = semanticFact(input);

    expect(first.factId).toBe(second.factId);
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.schemaVersion).toBe(1);
    expect(first.payload).not.toHaveProperty("astNode");
    expect(first.payload).not.toHaveProperty("modelScore");
    expect(first.payload).not.toHaveProperty("node");
    expect(first.payload).not.toHaveProperty("tsProgram");
    expect(first).not.toHaveProperty("sourceText");
    expect(JSON.stringify(first)).not.toContain("declare const");
  });

  it("stores emitted facts in insertion order", () => {
    const sink = createMemoryFactSink();
    sink.emit(
      semanticFact({
        factKind: "parserServices",
        ruleId: "antidrift/test",
        adapterId: "typescript-eslint/parser-services",
        confidence: "deterministic-inventory",
        provenance: ["parser-services-required"],
        payload: { available: true },
      }),
    );

    expect(sink.facts).toHaveLength(1);
    expect(sink.facts[0]?.factKind).toBe("parserServices");
  });

  it("serializes facts as newline-delimited JSON without owning file IO", () => {
    const lines = [];
    const sink = createJsonlFactSink((line) => lines.push(line));
    const fact = semanticFact({
      factKind: "structuralMatch",
      ruleId: "antidrift/no-structural-type-fork",
      adapterId: "typescript-eslint/type-owner",
      confidence: "deterministic-enforcement",
      provenance: ["TypeChecker", "AST"],
      payload: { localType: { name: "UserInfo" } },
    });

    sink.emit(fact);

    expect(lines).toEqual([semanticFactToJsonLine(fact)]);
    expect(lines[0]).toContain(`"factId":"${fact.factId}"`);
  });
});
