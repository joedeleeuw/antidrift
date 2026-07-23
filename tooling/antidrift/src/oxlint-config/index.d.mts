import type { OxlintConfig } from "oxlint";

export interface AntidriftOxlintConfigOptions {
  repoRoot?: string;
  policyDir?: string;
}

export function createOxlintConfig(
  options?: AntidriftOxlintConfigOptions,
): OxlintConfig;

export default createOxlintConfig;
