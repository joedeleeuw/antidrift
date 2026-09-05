import type { DummyRuleMap, OxlintConfig } from "oxlint";
export type AntidriftAdoptionPresetName =
  | "eslint"
  | "import"
  | "jsdoc"
  | "node"
  | "oxc"
  | "promise"
  | "react"
  | "typescript"
  | "unicorn"
  | "vitest"
  | "jsx-a11y";
export const antidriftAdoptionPresets: Readonly<
  Record<AntidriftAdoptionPresetName, Readonly<DummyRuleMap>>
>;
export function createAdoptionOxlintConfig(options: {
  presets: readonly AntidriftAdoptionPresetName[];
}): OxlintConfig;
