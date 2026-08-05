import type { DummyRuleMap, OxlintConfig } from "oxlint";

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

export const antidriftTypescriptSyntaxRules: DummyRuleMap;

export const antidriftTypescriptTypeAwareRules: DummyRuleMap;

export function typescriptBaselineTier(
  repoRoot?: string,
): "full" | "syntax-only";

export function createGovernanceOxlintConfig(
  options?: AntidriftGovernanceOxlintConfigOptions,
): OxlintConfig;

export default createGovernanceOxlintConfig;
