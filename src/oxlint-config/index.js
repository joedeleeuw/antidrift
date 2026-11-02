import { rules } from "../oxlint-plugin/index.js";

export const recommendedRules = Object.freeze(
  Object.fromEntries(
    Object.keys(rules).map((ruleName) => [`antidrift/${ruleName}`, "error"])
  )
);

export function createOxlintConfig(options = {}) {
  const {
    pluginSpecifier = "@joedeleeuw/antidrift",
    rules: ruleOverrides = {},
    ignorePatterns,
  } = options;
  return {
    jsPlugins: [pluginSpecifier],
    rules: {
      ...recommendedRules,
      ...ruleOverrides,
    },
    ...(Array.isArray(ignorePatterns) && ignorePatterns.length > 0
      ? { ignorePatterns }
      : {}),
  };
}

export const oxlintPreset = createOxlintConfig();

export default oxlintPreset;
