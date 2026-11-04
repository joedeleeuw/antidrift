import {
  type AntidriftEslintConfig,
  type CreateEslintConfigOptions,
  createEslintConfig,
  eslintPreset,
  eslintTypedPreset,
} from "./eslint-config/index.js";
import {
  type AntidriftOxlintConfig,
  type CreateOxlintConfigOptions,
  astOnlyPreset,
  astOnlyRules,
  createOxlintConfig,
  oxlintPreset,
  recommendedRules,
  typedRuleNames,
  typedRules,
} from "./oxlint-config/index.js";
import {
  type AntidriftRuleModule,
  antidriftPlugin,
  rules,
} from "./oxlint-plugin/index.js";

export {
  type AntidriftEslintConfig,
  type AntidriftOxlintConfig,
  type AntidriftRuleModule,
  type CreateEslintConfigOptions,
  type CreateOxlintConfigOptions,
  antidriftPlugin,
  astOnlyPreset,
  astOnlyRules,
  createEslintConfig,
  createOxlintConfig,
  eslintPreset,
  eslintTypedPreset,
  oxlintPreset,
  recommendedRules,
  rules,
  typedRuleNames,
  typedRules,
};

export default antidriftPlugin;
