import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

export const SEMANTIC_FACT_SCHEMA_VERSION = 1;

export const SEMANTIC_FACT_KINDS = Object.freeze({
  broadSetterCoMutation: Object.freeze({
    rules: Object.freeze(["antidrift/no-handrolled-resource-lifecycle-cells"]),
    adapterId: "react-state",
    carrier: "semantic-adapter",
    confidence: Object.freeze(["heuristic-inventory"]),
    emission: Object.freeze(["inventory-only"]),
    association: "React setter calls to state cells within one function frame.",
    noSinkBehavior:
      "No fact is emitted and no diagnostic is produced; broad co-mutation remains non-blocking.",
    payloadFields: Object.freeze([
      "transition",
      "requestGuard",
      "setterCount",
      "cells",
    ]),
  }),
  resourceLifecycleProof: Object.freeze({
    rules: Object.freeze(["antidrift/no-handrolled-resource-lifecycle-cells"]),
    adapterId: "react-state",
    carrier: "semantic-adapter",
    confidence: Object.freeze(["deterministic-enforcement"]),
    emission: Object.freeze(["blocking-diagnostic"]),
    association:
      "React state cells to lifecycle roles through async transition writes, awaited resource assignment, caught error assignment, and request-guard evidence.",
    noSinkBehavior:
      "The diagnostic still reports; only the serialized semantic fact is skipped.",
    payloadFields: Object.freeze([
      "boolCell",
      "errorCell",
      "payloadCell",
      "transition",
      "requestGuard",
      "setterCount",
      "cells",
    ]),
  }),
  structuralMatch: Object.freeze({
    rules: Object.freeze([
      "antidrift/no-canonical-model-fork",
      "antidrift/no-structural-type-fork",
    ]),
    adapterId: "typescript-eslint/type-owner",
    carrier: "authority-registry",
    confidence: Object.freeze([
      "deterministic-enforcement",
      "deterministic-inventory",
    ]),
    emission: Object.freeze(["blocking-diagnostic", "inventory-proposal"]),
    association:
      "Local handwritten object contracts to accepted or proposed generated, domain, or package owner types.",
    noSinkBehavior:
      "Accepted generated, domain, and package owner diagnostics still report; unaccepted installed-package owner proposals are not collected.",
    payloadFields: Object.freeze([
      "authorityState",
      "diagnostic",
      "localType",
      "ownerType",
      "structuralMatch",
    ]),
  }),
});

export const SEMANTIC_FACT_KIND_CONTRACT_LIST = Object.freeze(
  Object.entries(SEMANTIC_FACT_KINDS).map(([factKind, contract]) =>
    Object.freeze({ factKind, ...contract }),
  ),
);

export function semanticFactKindContractsForAdapterId(adapterId) {
  return Object.freeze(
    SEMANTIC_FACT_KIND_CONTRACT_LIST.filter(
      (contract) => contract.adapterId === adapterId,
    ),
  );
}

export function semanticFactKindContractsForRule(ruleId) {
  return Object.freeze(
    SEMANTIC_FACT_KIND_CONTRACT_LIST.filter((contract) =>
      contract.rules.includes(ruleId),
    ),
  );
}

export function semanticFactKindContractsForEmission(emission) {
  return Object.freeze(
    SEMANTIC_FACT_KIND_CONTRACT_LIST.filter((contract) =>
      contract.emission.includes(emission),
    ),
  );
}

export function semanticFactKindContractsForConfidence(confidence) {
  return Object.freeze(
    SEMANTIC_FACT_KIND_CONTRACT_LIST.filter((contract) =>
      contract.confidence.includes(confidence),
    ),
  );
}

const droppedPayloadKeys = new Set([
  "astNode",
  "checker",
  "fullSource",
  "node",
  "program",
  "sourceFile",
  "sourceText",
  "typeChecker",
  "modelScore",
  "tsNode",
  "tsProgram",
  "tsSymbol",
  "tsType",
]);

function normalized(value) {
  if (value instanceof Map) return normalized([...value.entries()]);
  if (Array.isArray(value)) return value.map((entry) => normalized(entry));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (droppedPayloadKeys.has(key)) continue;
    out[key] = normalized(value[key]);
  }
  return out;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function locationFor(node) {
  if (!node?.loc?.start) return undefined;
  const location = {
    column: node.loc.start.column,
    line: node.loc.start.line,
  };
  if (node.loc.end) {
    location.endColumn = node.loc.end.column;
    location.endLine = node.loc.end.line;
  }
  return location;
}

function contextFilePath(context, repoRoot) {
  const filename =
    context.filename ??
    context.getFilename?.() ??
    context.sourceCode?.filename ??
    "<unknown>";
  if (repoRoot && isAbsolute(filename)) return relative(repoRoot, filename);
  return filename;
}

function sourceHash(context) {
  const text = context.sourceCode?.text;
  return typeof text === "string" ? digest({ text }) : undefined;
}

export function semanticFact(input) {
  const payload = normalized(input.payload ?? {});
  const base = {
    schemaVersion: SEMANTIC_FACT_SCHEMA_VERSION,
    factKind: input.factKind,
    ruleId: input.ruleId,
    adapterId: input.adapterId,
    confidence: input.confidence,
    provenance: [...(input.provenance ?? [])].sort((left, right) =>
      left.localeCompare(right),
    ),
    filePath: input.filePath,
    location: input.location,
    fileHash: input.fileHash,
    payload,
  };
  const evidenceHash =
    input.evidenceHash ??
    digest({
      factKind: base.factKind,
      ruleId: base.ruleId,
      adapterId: base.adapterId,
      confidence: base.confidence,
      provenance: base.provenance,
      payload,
    });
  return {
    ...base,
    evidenceHash,
    factId:
      input.factId ??
      digest({
        factKind: base.factKind,
        ruleId: base.ruleId,
        adapterId: base.adapterId,
        filePath: base.filePath,
        location: base.location,
        evidenceHash,
      }),
  };
}

export function createMemoryFactSink() {
  const facts = [];
  return {
    facts,
    emit(fact) {
      facts.push(fact);
    },
  };
}

export function semanticFactToJsonLine(fact) {
  return `${JSON.stringify(normalized(fact))}\n`;
}

export function createJsonlFactSink(writeLine) {
  return {
    emit(fact) {
      writeLine(semanticFactToJsonLine(fact));
    },
  };
}

export function semanticFactSink(context) {
  const config = context.settings?.antidrift?.semanticFacts;
  if (!config) return null;
  if (typeof config === "function") return { config, emit: config };
  const sink = config.sink ?? config;
  if (typeof sink === "function") return { config, emit: sink };
  if (sink && typeof sink.emit === "function") {
    return { config, emit: (fact) => sink.emit(fact) };
  }
  return null;
}

export function emitSemanticFact(context, node, input) {
  const sink = semanticFactSink(context);
  if (!sink) return null;
  const fact = semanticFact({
    ...input,
    filePath: input.filePath ?? contextFilePath(context, sink.config?.repoRoot),
    fileHash: input.fileHash ?? sourceHash(context),
    location: input.location ?? locationFor(node),
  });
  sink.emit(fact);
  return fact;
}
