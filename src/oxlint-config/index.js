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

export const typedRuleNames = Object.freeze([
  "no-appeasement-cast",
  "no-appeasement-erasure",
  "no-calling-components-as-functions",
  "no-closed-string-parameter",
  "no-compat-names",
  "no-contract-appeasement-projection",
  "no-explicit-type-arguments-on-owned-api",
  "no-hypothetical-seam",
  "no-pass-through-parameters",
  "no-redundant-schema-parse",
  "no-redundant-type-predicate",
  "no-service-constructor-imports",
  "no-sql-string-concat",
  "no-structural-type-fork",
  "no-underchecked-type-predicate",
  "no-unformatted-number",
  "no-unresolved-dependency-types",
  "no-wrapping-functions",
  "optional-input-earns-optionality",
  "react-max-component-props",
  "unknown-input-must-be-decoded",
]);

const typedRuleNameSet = new Set(typedRuleNames);

export const recommendedRules = Object.freeze(
  Object.fromEntries(
    Object.keys(rules).map((ruleName) => [`antidrift/${ruleName}`, "error"])
  )
);

export const typedRules = Object.freeze(
  Object.fromEntries(
    typedRuleNames.map((ruleName) => [`antidrift/${ruleName}`, "error"])
  )
);

export const astOnlyRules = Object.freeze(
  Object.fromEntries(
    Object.keys(rules)
      .filter((ruleName) => !typedRuleNameSet.has(ruleName))
      .map((ruleName) => [`antidrift/${ruleName}`, "error"])
  )
);

export function createOxlintConfig(options = {}) {
  const {
    pluginSpecifier = "@joedeleeuw/antidrift",
    rules: ruleOverrides = {},
    ignorePatterns = [],
    typedRules: includeTyped = true,
  } = options;
  return {
    jsPlugins: [pluginSpecifier],
    ignorePatterns: [...new Set([...defaultIgnorePatterns, ...ignorePatterns])],
    rules: {
      ...(includeTyped ? recommendedRules : astOnlyRules),
      ...ruleOverrides,
    },
  };
}

export const oxlintPreset = createOxlintConfig();

export const astOnlyPreset = createOxlintConfig({ typedRules: false });

export default oxlintPreset;
