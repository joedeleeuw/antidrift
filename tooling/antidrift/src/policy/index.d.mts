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

export function loadRegistriesSync(policyDir?: string): AntidriftRegistries;
export function renderPolicyArtifacts(
  policy: AgentGuardrailsPolicy
): PolicyArtifacts;
export function loadPolicy(policyPath?: string): Promise<AgentGuardrailsPolicy>;
export function generate(): Promise<void>;
export function checkGenerated(options?: PolicyCommandOptions): unknown;
export function checkChanged(options?: PolicyCommandOptions): unknown;
export function checkRegistries(options?: PolicyCommandOptions): unknown;
export function defaultAstGrepBinary(): string;
export const DEFAULT_AST_GREP_CONFIG: string;
export function parseShellGuardrailsArgs(argv?: string[]): ShellGuardrailsArgs;
export function shellGuardrails(options?: PolicyCommandOptions): number;
export function parseOxlintArgs(argv: string[]): OxlintArgs;
export function runOxlint(options?: PolicyCommandOptions): number;
export function verifySession(): void;
