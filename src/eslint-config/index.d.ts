import type tsParser from "@typescript-eslint/parser";

import type { antidriftPlugin } from "../oxlint-plugin/index.js";

export declare const defaultIgnorePatterns: readonly string[];

export declare const typedRuleNames: readonly string[];

export declare const recommendedRules: Readonly<Record<string, "error">>;

export declare const typedRules: Readonly<Record<string, "error">>;

export declare const astOnlyRules: Readonly<Record<string, "error">>;

type ParserOptions = NonNullable<Parameters<typeof tsParser.parseForESLint>[1]>;

export interface CreateEslintConfigOptions {
  readonly files?: readonly string[];
  readonly ignores?: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly typedOnly?: boolean;
  readonly tsconfigRootDir?: string;
  readonly projectService?: ParserOptions["projectService"];
}

export interface AntidriftEslintConfig {
  readonly name: "antidrift/recommended" | "antidrift/typed";
  readonly files?: readonly string[];
  readonly ignores: string[];
  readonly languageOptions: {
    readonly parser: typeof tsParser;
    readonly parserOptions: {
      readonly ecmaFeatures: { readonly jsx: true };
      readonly projectService?: ParserOptions["projectService"];
      readonly tsconfigRootDir?: string;
    };
  };
  readonly plugins: {
    readonly antidrift: typeof antidriftPlugin;
  };
  readonly rules: Record<string, unknown>;
}

export declare function createEslintConfig(
  options?: CreateEslintConfigOptions
): AntidriftEslintConfig;

export declare const eslintPreset: AntidriftEslintConfig;

export declare const eslintTypedPreset: AntidriftEslintConfig;

export default eslintPreset;
