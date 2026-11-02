import { rules } from "../oxlint-plugin/index.js";

const IGNORE_DIRS = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".output",
  ".nitro",
  ".tanstack",
  ".sst",
  ".vinxi",
  ".next",
  ".expo",
  ".wrangler",
  "_generated",
  ".agents",
  ".claude",
  ".sudocode",
  ".scratch",
  ".agent-sources",
  ".repos",
  "src-tauri/target",
  "src-tauri/gen",
];

export const defaultIgnorePatterns = Object.freeze([
  ...IGNORE_DIRS.flatMap((dir) => [`${dir}/**`, `**/${dir}/**`]),
  "**/*.gen.*",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.tsbuildinfo",
]);

export const recommendedRules = Object.freeze(
  Object.fromEntries(
    Object.keys(rules).map((ruleName) => [`antidrift/${ruleName}`, "error"])
  )
);

export function createOxlintConfig(options = {}) {
  const {
    pluginSpecifier = "@joedeleeuw/antidrift",
    rules: ruleOverrides = {},
    ignorePatterns = [],
  } = options;
  return {
    jsPlugins: [pluginSpecifier],
    ignorePatterns: [...new Set([...defaultIgnorePatterns, ...ignorePatterns])],
    rules: {
      ...recommendedRules,
      ...ruleOverrides,
    },
  };
}

export const oxlintPreset = createOxlintConfig();

export default oxlintPreset;
