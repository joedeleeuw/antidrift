import {
  defaultIgnorePatterns,
  recommendedRules,
} from "../oxlint-config/index.js";
import { antidriftPlugin } from "../oxlint-plugin/index.js";

export { defaultIgnorePatterns, recommendedRules };

export function createEslintConfig(options = {}) {
  const { files, ignores = [], rules: ruleOverrides = {} } = options;
  return {
    name: "antidrift/recommended",
    ...(Array.isArray(files) && files.length > 0 ? { files } : {}),
    ignores: [...new Set([...defaultIgnorePatterns, ...ignores])],
    plugins: {
      antidrift: antidriftPlugin,
    },
    rules: {
      ...recommendedRules,
      ...ruleOverrides,
    },
  };
}

export const eslintPreset = createEslintConfig();

export default eslintPreset;
