export declare const defaultIgnorePatterns: readonly string[];

export declare const typedRuleNames: readonly string[];

export declare const recommendedRules: Readonly<Record<string, "error">>;

export declare const typedRules: Readonly<Record<string, "error">>;

export declare const astOnlyRules: Readonly<Record<string, "error">>;

export interface CreateOxlintConfigOptions {
  readonly pluginSpecifier?: string;
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly ignorePatterns?: readonly string[];
  readonly typedRules?: boolean;
}

export interface AntidriftOxlintConfig {
  readonly jsPlugins: string[];
  readonly rules: Record<string, unknown>;
  readonly ignorePatterns: string[];
}

export declare function createOxlintConfig(
  options?: CreateOxlintConfigOptions
): AntidriftOxlintConfig;

export declare const oxlintPreset: AntidriftOxlintConfig;

export declare const astOnlyPreset: AntidriftOxlintConfig;

export default oxlintPreset;
