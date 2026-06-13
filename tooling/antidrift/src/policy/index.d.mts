export interface PolicyRule {
  id: string;
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
}

export type PolicyArtifacts = Map<string, string>;
export type PolicyCommandOptions = Record<string, unknown>;

export function loadRegistriesSync(policyDir?: string): AntidriftRegistries;
export function renderPolicyArtifacts(policy: AgentGuardrailsPolicy): PolicyArtifacts;
export function loadPolicy(policyPath?: string): Promise<AgentGuardrailsPolicy>;
export function generate(): Promise<void>;
export function checkGenerated(options?: PolicyCommandOptions): unknown;
export function checkChanged(options?: PolicyCommandOptions): unknown;
export function checkRegistries(options?: PolicyCommandOptions): unknown;
export function checkRuleSurface(options?: PolicyCommandOptions): unknown;
export function repoCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function chaskiCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function externalCorpus(options?: PolicyCommandOptions): Promise<unknown>;
export function verifySession(options?: PolicyCommandOptions): unknown;
export function eslintJsonToSonar(inputPath?: string, outputPath?: string): Promise<void>;
export function unsafeTypeAssertionBenchmark(options?: PolicyCommandOptions): Promise<unknown>;
export function sqlQueryBenchmark(options?: PolicyCommandOptions): Promise<unknown>;
export function sqlBroadInventory(options?: PolicyCommandOptions): Promise<unknown>;
export function schemaRoundtripInventory(options?: PolicyCommandOptions): unknown;
