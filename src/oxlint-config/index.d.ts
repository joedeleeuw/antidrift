export declare const recommendedRules: Readonly<Record<string, "error">>;

export interface CreateOxlintConfigOptions {
  readonly pluginSpecifier?: string;
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly ignorePatterns?: readonly string[];
}

export interface AntidriftOxlintConfig {
  readonly jsPlugins: readonly string[];
  readonly rules: Readonly<Record<string, unknown>>;
  readonly ignorePatterns?: readonly string[];
}

export declare function createOxlintConfig(
  options?: CreateOxlintConfigOptions
): AntidriftOxlintConfig;

export declare const oxlintPreset: AntidriftOxlintConfig;

export default oxlintPreset;
