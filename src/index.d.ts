import {
  type AntidriftEslintConfig,
  type CreateEslintConfigOptions,
  createEslintConfig,
  eslintPreset,
} from "./eslint-config/index.js";
import {
  type AntidriftOxlintConfig,
  type CreateOxlintConfigOptions,
  createOxlintConfig,
  oxlintPreset,
  recommendedRules,
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
  createEslintConfig,
  createOxlintConfig,
  eslintPreset,
  oxlintPreset,
  recommendedRules,
  rules,
};

export default antidriftPlugin;
