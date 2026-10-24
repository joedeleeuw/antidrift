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
  reactNative: unknown;
}

export type PolicyArtifacts = Map<string, string>;
export type PolicyCommandOptions = Record<string, unknown>;

export interface ShellGuardrailsArgs {
  astGrepBinary: string;
  config: string;
  cwd: string;
  mode: "scan" | "test";
  passthrough: string[];
  help: boolean;
}

export interface OxlintArgs {
  targets: string[];
  passthrough: string[];
  help: boolean;
}

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
  | "identitySchemaTransform"
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
  adapterId: string
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForConfidence(
  confidence: string
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForEmission(
  emission: string
): readonly SemanticFactKindContractEntry[];
export function semanticFactKindContractsForRule(
  ruleId: string
): readonly SemanticFactKindContractEntry[];
export function semanticFact(input: SemanticFactInput): SemanticFact;
export function createMemoryFactSink(): MemorySemanticFactSink;
export function semanticFactToJsonLine(fact: SemanticFact): string;
export function createJsonlFactSink(
  writeLine: (line: string) => void
): SemanticFactSink;
export function renderPolicyArtifacts(
  policy: AgentGuardrailsPolicy
): PolicyArtifacts;
export function loadPolicy(policyPath?: string): Promise<AgentGuardrailsPolicy>;
export function generate(): Promise<void>;
export function checkGenerated(options?: PolicyCommandOptions): unknown;
export function checkChanged(options?: PolicyCommandOptions): unknown;
export function checkRegistries(options?: PolicyCommandOptions): unknown;
export function checkRuleSurface(options?: PolicyCommandOptions): unknown;
export function defensiveShapeInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function declarationCloneInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function repoCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function chaskiCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function externalCorpus(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function defaultAstGrepBinary(): string;
export const DEFAULT_AST_GREP_CONFIG: string;
export function parseShellGuardrailsArgs(argv?: string[]): ShellGuardrailsArgs;
export function shellGuardrails(options?: PolicyCommandOptions): number;
export function parseOxlintArgs(
  argv: string[],
  options?: {
    cwd?: string;
    exists?: (path: string) => boolean;
  }
): OxlintArgs;
export function runOxlint(options?: PolicyCommandOptions): number;
export function verifySession(): void;
export function eslintJsonToSonar(
  inputPath?: string,
  outputPath?: string
): Promise<void>;
export function unsafeTypeAssertionBenchmark(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function sqlQueryBenchmark(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function classifySqlParserServiceDelta(
  probe?: SqlParserServiceDeltaInput | null
): SqlParserServiceDeltaClassification;
export function sqlBroadInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function reactStateInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function classifyReactStateFact(fact: SemanticFact): string;
export function schemaRoundtripInventory(
  options?: PolicyCommandOptions
): unknown;
export function typeOwnerInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
export function undercheckedPredicateInventory(
  options?: PolicyCommandOptions
): Promise<unknown>;
