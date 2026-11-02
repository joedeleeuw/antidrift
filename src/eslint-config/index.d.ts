import type { antidriftPlugin } from "../oxlint-plugin/index.js";

export declare const defaultIgnorePatterns: readonly string[];

export declare const recommendedRules: Readonly<Record<string, "error">>;

export interface CreateEslintConfigOptions {
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
}

export interface AntidriftEslintConfig {
  readonly name: "antidrift/recommended";
  readonly files?: readonly string[];
  readonly ignores: string[];
  readonly plugins: {
    readonly antidrift: typeof antidriftPlugin;
  };
  readonly rules: Record<string, unknown>;
}

export declare function createEslintConfig(
  options?: CreateEslintConfigOptions
): AntidriftEslintConfig;

export declare const eslintPreset: AntidriftEslintConfig;

export default eslintPreset;
