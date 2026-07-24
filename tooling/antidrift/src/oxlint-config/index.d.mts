import type { OxlintConfig } from "oxlint";

export interface AntidriftGovernanceOxlintConfigOptions {
  repoRoot?: string;
  policyDir?: string;
}

export const antidriftComplexityRules: Readonly<{
  complexity: readonly [
    "error",
    Readonly<{ max: 25; variant: "modified" }>,
  ];
  "max-depth": readonly ["error", 4];
  "max-params": readonly ["error", Readonly<{ max: 7 }>];
}>;

export function createGovernanceOxlintConfig(
  options?: AntidriftGovernanceOxlintConfigOptions,
): OxlintConfig;

export default createGovernanceOxlintConfig;
