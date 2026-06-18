import * as asyncControlFlow from "./async-control-flow.mjs";
import * as authBoundary from "./auth-boundary.mjs";
import * as broadInput from "./broad-input.mjs";
import * as parseInput from "./parse-input.mjs";
import * as reactState from "./react-state.mjs";
import * as schemaProvenance from "./schema-provenance.mjs";
import * as sql from "./sql.mjs";
import * as tupleShape from "./tuple-shape.mjs";
import * as typeOwner from "./type-owner.mjs";
import { SEMANTIC_FACT_KIND_CONTRACT_LIST } from "../policy/lib/semantic-facts.mjs";

export {
  asyncControlFlow,
  authBoundary,
  broadInput,
  parseInput,
  reactState,
  schemaProvenance,
  sql,
  tupleShape,
  typeOwner,
};

export const SEMANTIC_ADAPTERS = Object.freeze({
  asyncControlFlow,
  authBoundary,
  broadInput,
  parseInput,
  reactState,
  schemaProvenance,
  sql,
  tupleShape,
  typeOwner,
});

export const SEMANTIC_ADAPTER_CONTRACTS = Object.freeze({
  asyncControlFlow: Object.freeze({
    id: "async-control-flow",
    exportName: "asyncControlFlow",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/async-control-flow",
    rules: Object.freeze(["antidrift/no-async-array-method"]),
    proofBuckets: Object.freeze([
      "local-ast-source-shape",
      "semantic-source-type-provenance",
    ]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "async array callback to collection method semantics",
      "map or flatMap promise collection to later Promise combinator consumption",
    ]),
    carrier: "AST callback shape plus local scope binding",
  }),
  authBoundary: Object.freeze({
    id: "auth-boundary",
    exportName: "authBoundary",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/auth-boundary",
    rules: Object.freeze(["antidrift/require-authz-check"]),
    proofBuckets: Object.freeze(["local-ast-source-shape", "graph-config-source"]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "route params to nearby configured authorization-call inventory",
    ]),
    carrier: "handler-local request-param shape plus configured callee names",
  }),
  broadInput: Object.freeze({
    id: "broad-input",
    exportName: "broadInput",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/broad-input",
    rules: Object.freeze([
      "antidrift/no-appeasement-cast",
      "antidrift/no-defensive-shape-probing",
      "antidrift/no-underchecked-type-predicate",
    ]),
    proofBuckets: Object.freeze(["semantic-source-type-provenance"]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "broad any/unknown source to named object contract assertion",
      "broad input to asserted object contract",
      "broad Object.entries value to mini-parser probe cluster",
    ]),
    carrier: "TypeChecker plus AST/control-flow checks",
  }),
  parseInput: Object.freeze({
    id: "parse-input",
    exportName: "parseInput",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/parse-input",
    rules: Object.freeze(["antidrift/no-unsafe-deserialize"]),
    proofBuckets: Object.freeze(["semantic-source-type-provenance"]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "JSON.parse input provenance to broad any or unknown values",
      "parse input to local string-boundary proof",
      "JSON.parse input provenance to broad any/unknown values and local string proof.",
    ]),
    carrier: "TypeChecker plus local parse-input control flow",
  }),
  reactState: Object.freeze({
    id: "react-state",
    exportName: "reactState",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/react-state",
    rules: Object.freeze([
      "antidrift/no-handrolled-resource-lifecycle-cells",
      "antidrift/no-shattered-ingested-entity-state",
    ]),
    proofBuckets: Object.freeze(["semantic-source-type-provenance"]),
    semanticFactAdapterIds: Object.freeze(["react-state"]),
    semanticFactKinds: Object.freeze([
      "broadSetterCoMutation",
      "resourceLifecycleProof",
      "sourceMemberStateShardCandidate",
    ]),
    associations: Object.freeze([
      "React state setter to cell",
      "state cell to resource lifecycle role",
      "source object member to state cell",
    ]),
    carrier: "React state graph semantic adapter",
  }),
  schemaProvenance: Object.freeze({
    id: "schema-provenance",
    exportName: "schemaProvenance",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/schema-provenance",
    rules: Object.freeze(["antidrift/no-redundant-zod-parse"]),
    proofBuckets: Object.freeze(["semantic-source-type-provenance"]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "parsed value to schema provenance",
      "call result to schema output type",
      "Values already proven as a Zod schema output to later parse calls on the same schema.",
    ]),
    carrier: "TypeChecker plus schema provenance",
  }),
  sql: Object.freeze({
    id: "sql",
    exportName: "sql",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/sql",
    rules: Object.freeze(["antidrift/no-sql-string-concat"]),
    proofBuckets: Object.freeze(["semantic-source-type-provenance"]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "SQL fragment to binding proof",
      "SQL identifier to escaping or allowlist proof",
      "SQL string fragments to bound values, identifier allowlists, escaping helpers, safe members, or unsafe interpolation.",
    ]),
    carrier: "SQL context plus local dataflow and TypeChecker proof",
  }),
  tupleShape: Object.freeze({
    id: "tuple-shape",
    exportName: "tupleShape",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/tuple-shape",
    rules: Object.freeze(["antidrift/no-nullable-positional-tuple"]),
    proofBuckets: Object.freeze([
      "local-ast-source-shape",
      "semantic-source-type-provenance",
    ]),
    semanticFactAdapterIds: Object.freeze([]),
    semanticFactKinds: Object.freeze([]),
    associations: Object.freeze([
      "tuple element positions to optional or nullish slot proof",
      "tuple element aliases to TypeChecker nullish resolution",
    ]),
    carrier: "AST tuple shape plus TypeChecker alias resolution",
  }),
  typeOwner: Object.freeze({
    id: "type-owner",
    exportName: "typeOwner",
    subpath: "@joedeleeuw/antidrift/semantic-adapters/type-owner",
    rules: Object.freeze([
      "antidrift/no-structural-type-fork",
      "antidrift/no-canonical-model-fork",
      "antidrift/no-status-literal-in-type",
    ]),
    proofBuckets: Object.freeze(["authority-index-ownership"]),
    semanticFactAdapterIds: Object.freeze(["typescript-eslint/type-owner"]),
    semanticFactKinds: Object.freeze(["structuralMatch"]),
    associations: Object.freeze([
      "local structural type to generated owner",
      "local structural type to domain owner",
      "local structural type to accepted package owner",
      "status literal to canonical domain status owner",
    ]),
    carrier: "TypeChecker plus authority index",
  }),
});

export const SEMANTIC_ADAPTER_CONTRACT_LIST = Object.freeze(
  Object.values(SEMANTIC_ADAPTER_CONTRACTS),
);

function semanticFactContractsForAdapterContract(contract) {
  return Object.freeze(
    contract.semanticFactKinds
      .map((factKind) =>
        SEMANTIC_FACT_KIND_CONTRACT_LIST.find(
          (factContract) => factContract.factKind === factKind,
        ),
      )
      .filter(Boolean),
  );
}

export const SEMANTIC_ADAPTER_MANIFEST = Object.freeze(
  SEMANTIC_ADAPTER_CONTRACT_LIST.map((contract) =>
    Object.freeze({
      ...contract,
      semanticFactContracts: semanticFactContractsForAdapterContract(contract),
    }),
  ),
);

export function semanticAdapterContractsForRule(ruleId) {
  return Object.freeze(
    SEMANTIC_ADAPTER_CONTRACT_LIST.filter((contract) =>
      contract.rules.includes(ruleId),
    ),
  );
}

export function semanticAdapterContractsForFactAdapterId(adapterId) {
  return Object.freeze(
    SEMANTIC_ADAPTER_CONTRACT_LIST.filter((contract) =>
      contract.semanticFactAdapterIds.includes(adapterId),
    ),
  );
}

export function semanticAdapterContractsForProofBucket(proofBucket) {
  return Object.freeze(
    SEMANTIC_ADAPTER_CONTRACT_LIST.filter((contract) =>
      contract.proofBuckets.includes(proofBucket),
    ),
  );
}

export function semanticAdapterContractsForFactKind(factKind) {
  return Object.freeze(
    SEMANTIC_ADAPTER_CONTRACT_LIST.filter((contract) =>
      contract.semanticFactKinds.includes(factKind),
    ),
  );
}

export function semanticAdapterManifestForAdapterId(adapterId) {
  return (
    SEMANTIC_ADAPTER_MANIFEST.find((contract) => contract.id === adapterId) ??
    null
  );
}

export function semanticAdapterManifestForRule(ruleId) {
  return Object.freeze(
    SEMANTIC_ADAPTER_MANIFEST.filter((contract) =>
      contract.rules.includes(ruleId),
    ),
  );
}

export function semanticAdapterManifestForFactAdapterId(adapterId) {
  return Object.freeze(
    SEMANTIC_ADAPTER_MANIFEST.filter((contract) =>
      contract.semanticFactAdapterIds.includes(adapterId),
    ),
  );
}

export function semanticAdapterManifestForProofBucket(proofBucket) {
  return Object.freeze(
    SEMANTIC_ADAPTER_MANIFEST.filter((contract) =>
      contract.proofBuckets.includes(proofBucket),
    ),
  );
}

export function semanticAdapterManifestForFactKind(factKind) {
  return Object.freeze(
    SEMANTIC_ADAPTER_MANIFEST.filter((contract) =>
      contract.semanticFactKinds.includes(factKind),
    ),
  );
}
