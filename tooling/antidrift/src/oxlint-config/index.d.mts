import type { OxlintConfig } from "oxlint";

export interface AntidriftGovernanceOxlintConfigOptions {
  repoRoot?: string;
  policyDir?: string;
}

export function createGovernanceOxlintConfig(
  options?: AntidriftGovernanceOxlintConfigOptions
): OxlintConfig;

export default createGovernanceOxlintConfig;
