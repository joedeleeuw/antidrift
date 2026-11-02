import { createEslintConfig, eslintPreset } from "./eslint-config/index.js";
import {
  createOxlintConfig,
  oxlintPreset,
  recommendedRules,
} from "./oxlint-config/index.js";
import { antidriftPlugin, rules } from "./oxlint-plugin/index.js";

export {
  antidriftPlugin,
  createEslintConfig,
  createOxlintConfig,
  eslintPreset,
  oxlintPreset,
  recommendedRules,
  rules,
};

export default antidriftPlugin;
