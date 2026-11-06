import tsParser from "@typescript-eslint/parser";

import {
  astOnlyRules,
  defaultIgnorePatterns,
  recommendedRules,
  typedRuleNames,
  typedRules,
} from "../oxlint-config/index.js";
import { antidriftPlugin } from "../oxlint-plugin/index.js";

export {
  astOnlyRules,
  defaultIgnorePatterns,
  recommendedRules,
  typedRuleNames,
  typedRules,
};

export function createEslintConfig(options = {}) {
  const {
    files,
    ignores = [],
    rules: ruleOverrides = {},
    typedOnly = false,
    tsconfigRootDir,
    projectService,
  } = options;
  const baseRules = typedOnly ? typedRules : recommendedRules;
  const enableProjectService = typedOnly || projectService === true;
  const projectServiceOptions = {};
  if (enableProjectService) {
    projectServiceOptions.projectService = projectService ?? true;
  } else if (projectService) {
    projectServiceOptions.projectService = projectService;
  }
  return {
    name: typedOnly ? "antidrift/typed" : "antidrift/recommended",
    ...(Array.isArray(files) && files.length > 0 ? { files } : {}),
    ignores: [...new Set([...defaultIgnorePatterns, ...ignores])],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ...projectServiceOptions,
        ...(tsconfigRootDir ? { tsconfigRootDir } : {}),
      },
    },
    plugins: {
      antidrift: antidriftPlugin,
    },
    rules: {
      ...baseRules,
      ...ruleOverrides,
    },
  };
}

export const eslintPreset = createEslintConfig();
export const eslintTypedPreset = createEslintConfig({ typedOnly: true });

export default eslintPreset;
