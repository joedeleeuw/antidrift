import type { OxlintConfig } from "oxlint";

export interface AntidriftGovernanceOxlintConfigOptions {
  repoRoot?: string;
  policyDir?: string;
  enforceNoPropertyDefaultFallbacks?: boolean;
  propertyDefaultAllowedFiles?: readonly string[];
}

export function createGovernanceOxlintConfig(
  options?: AntidriftGovernanceOxlintConfigOptions
): OxlintConfig;

export default createGovernanceOxlintConfig;
