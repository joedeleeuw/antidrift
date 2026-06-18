export interface PolicyRule {
  id: string;
  status?: string;
  severity?: string;
  detector?: string;
  message?: string;
  replacement?: string;
  mergedInto?: string;
}

export interface PolicyCluster {
  id: string;
  owner: string;
  rules: PolicyRule[];
}

export interface AgentGuardrailsPolicy {
  clusters: PolicyCluster[];
}

export interface AntidriftRegistries {
  domain: unknown;
  gateways: unknown;
  architecture: unknown;
  boundaries: unknown;
  generated: unknown;
  ownership: unknown;
}

export type PolicyArtifacts = Map<string, string>;
export type PolicyCommandOptions = Record<string, unknown>;

export type SemanticFactConfidence =
  | "deterministic-enforcement"
  | "deterministic-inventory"
  | "heuristic-inventory"
  | "model-suggestion";

export type SemanticFactCarrier =
  | "semantic-adapter"
  | "authority-registry"
  | "type-aware-eslint"
  | "repo-graph"
  | "agent-ops"
  | "model-assisted"
  | "policy-script"
  | "change-relative";

export type SemanticFactEmission =
  | "blocking-diagnostic"
  | "inventory-only"
  | "inventory-proposal";

export type SemanticFactProvenance =
  | "AST"
  | "TypeChecker"
  | "control-flow"
  | "parser-services-required"
  | "registry"
  | "scope-binding"
  | "change-contract"
  | "git-diff"
  | "ts-program"
  | "package-manifest";

export type RuleStatusEntryKind =
  | "active"
  | "retired"
  | "research"
  | "policy-review";

export type RuleStatusProofBucket =
  | "local-ast-source-shape"
  | "semantic-source-type-provenance"
  | "authority-index-ownership"
  | "graph-config-source"
  | "repo-session-runtime"
  | "diff-relative";

export interface RuleStatusPromotion {
  proofBucket: RuleStatusProofBucket;
  association: string;
  blockingThreshold: string;
  ecosystemComparison: string;
  corpusEvidence: string;
  realCorpusInventory: string;
  realCorpusInventoryRefs: readonly string[];
  claudeAdvisoryReview: string;
  claudeAdvisoryReviewRefs: readonly string[];
  replicationsNotIntroducedForTest: boolean;
  knownFalsePositives: number;
  knownFalseNegatives: number;
  productionConcerns: string;
  noSinkBehavior: string;
  noDeadWorkBehavior: string;
}

export interface RuleStatusSemanticAdapterStatus {
  status: "inline-pending";
  reason: string;
}

export interface RuleStatusExamples {
  exhaustive: false;
  flags: readonly string[];
  allows: readonly string[];
}

export type SqlParserServiceDeltaClassification =
  | "not-applicable"
  | "equivalent-without-parser-services"
  | "conservative-inventory-without-parser-services"
  | "blocking-false-negative-without-parser-services"
  | "mixed-parser-service-delta"
  | "parser-error";

export interface SemanticFactLocation {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface SemanticFactInput {
  factKind: string;
  ruleId: string;
  adapterId: string;
  confidence: SemanticFactConfidence;
  provenance?: SemanticFactProvenance[];
  filePath?: string;
  location?: SemanticFactLocation;
  fileHash?: string;
  evidenceHash?: string;
  factId?: string;
  payload?: Record<string, unknown>;
}

export interface SemanticFact extends SemanticFactInput {
  schemaVersion: 1;
  provenance: SemanticFactProvenance[];
  evidenceHash: string;
  factId: string;
  payload: Record<string, unknown>;
}

export interface SemanticFactSink {
  emit(fact: SemanticFact): void;
}

export interface MemorySemanticFactSink extends SemanticFactSink {
  facts: SemanticFact[];
}

export interface RuleStatusManifestEntry {
  id: string;
  kind: RuleStatusEntryKind;
  status?: string;
  stable?: boolean;
  signal?: string;
  solveType?: string;
  proofBuckets?: readonly RuleStatusProofBucket[];
  referenceDoc?: string;
  replacement?: string;
  mergedInto?: string;
  reason?: string;
  nextAction?: string;
  antidriftRule?: string;
  coverage?: string;
  corpusRepositories?: readonly string[];
  external?: unknown;
  examples?: RuleStatusExamples;
  promotion?: RuleStatusPromotion;
  semanticAdapterStatus?: RuleStatusSemanticAdapterStatus;
}

export interface RuleStatusManifest {
  schemaVersion: number;
  promotionRequirements: unknown;
  entries: readonly RuleStatusManifestEntry[];
}

export interface RuleStatusSemanticAdapterSummary {
  id: string;
  exportName: string;
  subpath: string;
  rules: readonly string[];
  proofBuckets: readonly string[];
  semanticFactAdapterIds: readonly string[];
  semanticFactKinds: readonly string[];
  associations: readonly string[];
  carrier: string;
  semanticFactContracts: readonly SemanticFactKindContractEntry[];
}

export interface RuleStatusSemanticSummary {
  entry: RuleStatusManifestEntry;
  proofBuckets: readonly string[];
  semanticAdapters: readonly RuleStatusSemanticAdapterSummary[];
  semanticFactContracts: readonly SemanticFactKindContractEntry[];
}

export interface SemanticFactKindContract {
  rules: readonly string[];
  commandIds?: readonly string[];
  adapterId: string;
  carrier: SemanticFactCarrier;
  confidence: readonly SemanticFactConfidence[];
  emission: readonly SemanticFactEmission[];
  association: string;
  noSinkBehavior: string;
  payloadFields: readonly string[];
}

export interface SemanticFactKindContractEntry extends SemanticFactKindContract {
  factKind: SemanticFactKind;
}

export type SemanticFactKind =
  | "broadSetterCoMutation"
  | "resourceLifecycleProof"
  | "sourceMemberStateShardCandidate"
  | "structuralMatch"
  | "changeContractConformance";

export interface SqlParserServiceDeltaInput {
  parserErrors?: number;
  comparisonWithTypeAware?: {
    extraWithoutTypeServices?: string[];
    missingWithoutTypeServices?: string[];
  };
}

export function loadRegistriesSync(policyDir?: string): AntidriftRegistries;
export const SEMANTIC_FACT_SCHEMA_VERSION: 1;
export const SEMANTIC_FACT_KINDS: Readonly<
  Record<SemanticFactKind, SemanticFactKindContract>
>;
export const SEMANTIC_FACT_KIND_CONTRACT_LIST: readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForAdapterId(
  adapterId: string,
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForConfidence(
  confidence: string,
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForEmission(
  emission: string,
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForRule(
  ruleId: string,
): readonly SemanticFactKindContractEntry[];
export function semanticFact(input: SemanticFactInput): SemanticFact;
export function createMemoryFactSink(): MemorySemanticFactSink;
export function semanticFactToJsonLine(fact: SemanticFact): string;
export function createJsonlFactSink(
  writeLine: (line: string) => void,
): SemanticFactSink;
export function loadRuleStatusRegistrySync(
  policyDir?: string,
): Record<string, unknown>;
export function ruleStatusManifest(
  registry?: Record<string, unknown>,
): RuleStatusManifest;
export function ruleStatusEntriesFromRegistry(
  registry?: Record<string, unknown>,
): readonly RuleStatusManifestEntry[];
export function ruleStatusEntryForId(
  id: string,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): RuleStatusManifestEntry | null;
export function ruleStatusEntriesForKind(
  kind: RuleStatusEntryKind,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): readonly RuleStatusManifestEntry[];
export function ruleStatusEntriesForProofBucket(
  proofBucket: string,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): readonly RuleStatusManifestEntry[];
export function ruleStatusEntriesForSemanticAdapter(
  adapterId: string,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): readonly RuleStatusManifestEntry[];
export function ruleStatusEntriesForStatus(
  status: string,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): readonly RuleStatusManifestEntry[];
export function ruleStatusSemanticSummaryForId(
  id: string,
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): RuleStatusSemanticSummary | null;
export function ruleStatusSemanticSummaries(
  manifestOrRegistry?: RuleStatusManifest | Record<string, unknown>,
): readonly RuleStatusSemanticSummary[];
export function renderPolicyArtifacts(
  policy: AgentGuardrailsPolicy,
): PolicyArtifacts;
export function loadPolicy(policyPath?: string): Promise<AgentGuardrailsPolicy>;
export function generate(): Promise<void>;
export function checkGenerated(options?: PolicyCommandOptions): unknown;
export function checkChanged(options?: PolicyCommandOptions): unknown;
export function checkRegistries(options?: PolicyCommandOptions): unknown;
export function checkRuleSurface(options?: PolicyCommandOptions): unknown;
export function defensiveShapeInventory(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function declarationCloneInventory(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function repoCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function chaskiCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function externalCorpus(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function verifySession(options?: PolicyCommandOptions): unknown;
export function eslintJsonToSonar(
  inputPath?: string,
  outputPath?: string,
): Promise<void>;
export function unsafeTypeAssertionBenchmark(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function sqlQueryBenchmark(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function classifySqlParserServiceDelta(
  probe?: SqlParserServiceDeltaInput | null,
): SqlParserServiceDeltaClassification;
export function sqlBroadInventory(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function reactStateInventory(
  options?: PolicyCommandOptions,
): Promise<unknown>;
export function classifyReactStateFact(fact: SemanticFact): string;
export function schemaRoundtripInventory(
  options?: PolicyCommandOptions,
): unknown;
export function undercheckedPredicateInventory(
  options?: PolicyCommandOptions,
): Promise<unknown>;
