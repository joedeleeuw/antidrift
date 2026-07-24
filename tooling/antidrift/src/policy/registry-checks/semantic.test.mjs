import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkRegistries } from "../check-registries.mjs";
import { checkSemanticAdapterContracts } from "./semantic-contracts.mjs";
import {
  replaceYamlSectionField,
  semanticAdapterAggregateRuntimeSource,
  semanticAdapterAggregateTypeSource,
  semanticAdapterContractKeys,
  semanticAdapterPackageExports,
  touchSemanticAdapterPackageExportFiles,
  workspace,
  writePackageJson,
  writeValidRulesRegistry,
} from "../../../test/support/registry-workspace.mjs";

describe("semantic contracts", () => {
  it.each(["eslint-plugin/rules", "oxlint-plugin/rules"])(
    "requires semantic fact kinds emitted from %s to be registered",
    (pluginDirectory) => {
      const root = workspace();
      writeValidRulesRegistry(root);
      const rulesDirectory = join(
        root,
        "tooling/antidrift/src",
        pluginDirectory,
      );
      mkdirSync(rulesDirectory, { recursive: true });
      writeFileSync(
        join(rulesDirectory, "example.js"),
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
    },
  );
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
          proofBuckets: ["diff-relative"],
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
      "test semantic adapter contracts.reactState.proofBuckets contains unsupported value 'diff-relative'",
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
  it("rejects semantic adapter aggregate runtime surfaces missing contract adapters", () => {
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
        "index.mjs",
      ),
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
});
