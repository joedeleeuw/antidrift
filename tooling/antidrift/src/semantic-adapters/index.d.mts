import * as asyncControlFlow from "./async-control-flow.mjs";
import * as authBoundary from "./auth-boundary.mjs";
import * as broadInput from "./broad-input.mjs";
import * as parseInput from "./parse-input.mjs";
import * as reactState from "./react-state.mjs";
import * as schemaProvenance from "./schema-provenance.mjs";
import * as sql from "./sql.mjs";
import * as tupleShape from "./tuple-shape.mjs";
import * as typeOwner from "./type-owner.mjs";
import type { SemanticFactKindContractEntry } from "../policy/index.mjs";

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

export const SEMANTIC_ADAPTERS: Readonly<{
  asyncControlFlow: typeof asyncControlFlow;
  authBoundary: typeof authBoundary;
  broadInput: typeof broadInput;
  parseInput: typeof parseInput;
  reactState: typeof reactState;
  schemaProvenance: typeof schemaProvenance;
  sql: typeof sql;
  tupleShape: typeof tupleShape;
  typeOwner: typeof typeOwner;
}>;

export type SemanticAdapterContractKey =
  | "asyncControlFlow"
  | "authBoundary"
  | "broadInput"
  | "parseInput"
  | "reactState"
  | "schemaProvenance"
  | "sql"
  | "tupleShape"
  | "typeOwner";

export interface SemanticAdapterContract {
  id: string;
  exportName: SemanticAdapterContractKey;
  subpath: string;
  rules: readonly string[];
  proofBuckets: readonly string[];
  semanticFactAdapterIds: readonly string[];
  semanticFactKinds: readonly string[];
  associations: readonly string[];
  carrier: string;
}

export interface SemanticAdapterManifestEntry extends SemanticAdapterContract {
  semanticFactContracts: readonly SemanticFactKindContractEntry[];
}

export const SEMANTIC_ADAPTER_CONTRACTS: Readonly<
  Record<SemanticAdapterContractKey, SemanticAdapterContract>
>;

export const SEMANTIC_ADAPTER_CONTRACT_LIST: readonly SemanticAdapterContract[];

export const SEMANTIC_ADAPTER_MANIFEST: readonly SemanticAdapterManifestEntry[];

export function semanticAdapterContractsForRule(
  ruleId: string,
): readonly SemanticAdapterContract[];

export function semanticAdapterContractsForFactAdapterId(
  adapterId: string,
): readonly SemanticAdapterContract[];

export function semanticAdapterContractsForProofBucket(
  proofBucket: string,
): readonly SemanticAdapterContract[];

export function semanticAdapterContractsForFactKind(
  factKind: string,
): readonly SemanticAdapterContract[];

export function semanticAdapterManifestForAdapterId(
  adapterId: string,
): SemanticAdapterManifestEntry | null;

export function semanticAdapterManifestForRule(
  ruleId: string,
): readonly SemanticAdapterManifestEntry[];

export function semanticAdapterManifestForFactAdapterId(
  adapterId: string,
): readonly SemanticAdapterManifestEntry[];

export function semanticAdapterManifestForProofBucket(
  proofBucket: string,
): readonly SemanticAdapterManifestEntry[];

export function semanticAdapterManifestForFactKind(
  factKind: string,
): readonly SemanticAdapterManifestEntry[];
