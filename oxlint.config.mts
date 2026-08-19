import { createRequire } from "node:module";

import {
  antidriftComplexityRules,
  antidriftTypescriptSyntaxRules,
  antidriftTypescriptTypeAwareRules,
  createGovernanceOxlintConfig,
} from "@joedeleeuw/antidrift/oxlint-config";
import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";

const packageRequire = createRequire(import.meta.url);
const governance = createGovernanceOxlintConfig({
  repoRoot: import.meta.dirname,
});
const nativePlugins = ["eslint", "import", "oxc", "react", "unicorn"] as const;
const complexityRules = {
  complexity: [
    antidriftComplexityRules.complexity[0],
    { ...antidriftComplexityRules.complexity[1] },
  ],
  "max-depth": [...antidriftComplexityRules["max-depth"]],
  "max-params": [
    antidriftComplexityRules["max-params"][0],
    { ...antidriftComplexityRules["max-params"][1] },
  ],
} satisfies DummyRuleMap;
const typescriptRules = {
  ...antidriftTypescriptSyntaxRules,
  ...antidriftTypescriptTypeAwareRules,
} satisfies DummyRuleMap;
const vitestRules = {
  "vitest/expect-expect": "error",
  "vitest/no-conditional-expect": "error",
  "vitest/no-focused-tests": "error",
  "vitest/no-disabled-tests": "error",
  "vitest/no-standalone-expect": "error",
  "vitest/no-test-prefixes": "error",
  "vitest/require-to-throw-message": "error",
} satisfies DummyRuleMap;

export default defineConfig({
  ...governance,
  categories: {
    ...governance.categories,
    correctness: "error",
  },
  env: {
    browser: true,
    node: true,
  },
  ignorePatterns: [
    ...(governance.ignorePatterns ?? []),
    "tooling/antidrift/src/eslint-plugin/fixtures/programs/**",
    "tooling/antidrift/src/brand/fixtures/programs/**",
    "tooling/antidrift/src/oxlint-plugin/fixtures/programs/**",
  ],
  jsPlugins: [
    ...(governance.jsPlugins ?? []),
    {
      name: "boundaries",
      specifier: packageRequire.resolve("eslint-plugin-boundaries"),
    },
  ],
  options: {
    ...governance.options,
    typeAware: true,
  },
  plugins: [...nativePlugins],
  settings: {
    "boundaries/elements": [
      { type: "app", pattern: "apps/*/src/**" },
      { type: "ui", pattern: "packages/ui/src/**" },
      { type: "domain", pattern: "packages/domain/src/**" },
      { type: "contracts", pattern: "packages/contracts/src/**" },
      { type: "api", pattern: "packages/api/src/**" },
      { type: "gateways", pattern: "packages/gateways/src/**" },
      { type: "tooling", pattern: "tooling/**" },
    ],
  },
  rules: {
    ...governance.rules,
    ...complexityRules,
    "react/react-compiler": "error",
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "error",
    "react/button-has-type": "error",
    "react/checked-requires-onchange-or-readonly": "error",
    "react/iframe-missing-sandbox": "error",
    "react/jsx-key": "error",
    "react/jsx-no-target-blank": "error",
    "react/jsx-no-duplicate-props": "error",
    "react/jsx-no-script-url": "error",
    "react/jsx-no-constructed-context-values": "error",
    "react/no-danger-with-children": "error",
    "react/no-unknown-property": "error",
    "react/no-children-prop": "error",
    "react/jsx-no-undef": "error",
    "react/jsx-no-comment-textnodes": "error",
    "preserve-caught-error": "error",
    "no-console": "error",
    "no-debugger": "error",
    "no-array-constructor": "error",
    "no-case-declarations": "error",
    "no-empty": "error",
    "no-fallthrough": "error",
    "no-promise-executor-return": "error",
    "no-prototype-builtins": "error",
    "no-unexpected-multiline": "error",
    "no-unreachable-loop": "error",
    "no-var": "error",
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "no-warning-comments": [
      "error",
      { terms: ["@nocommit", "FIXME"], location: "anywhere" },
    ],
    "no-nested-ternary": "error",
    "unicorn/no-abusive-eslint-disable": "error",
    "unicorn/no-await-in-promise-methods": "error",
    "unicorn/no-invalid-fetch-options": "error",
    "unicorn/no-single-promise-in-promise-methods": "error",
    "unicorn/no-useless-promise-resolve-reject": "error",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/require-post-message-target-origin": "error",
    curly: ["error", "multi-line"],
    "boundaries/element-types": [
      "error",
      {
        default: "disallow",
        rules: [
          { from: "app", allow: ["ui", "domain", "contracts"] },
          { from: "ui", allow: ["domain"] },
          { from: "domain", allow: [] },
          { from: "contracts", allow: ["domain"] },
          { from: "api", allow: ["domain", "contracts", "gateways"] },
          { from: "gateways", allow: ["domain", "contracts"] },
          { from: "tooling", allow: ["tooling"] },
        ],
      },
    ],
    "boundaries/no-private": "error",
    "import/no-cycle": ["error", { ignoreExternal: true }],
    "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
    "import/first": "error",
    "import/newline-after-import": ["error", { count: 1 }],
    "import/no-duplicates": "error",
    "import/no-absolute-path": "error",
    "import/no-amd": "error",
    "import/no-empty-named-blocks": "error",
    "import/no-mutable-exports": "error",
    "import/no-named-default": "error",
    "import/no-self-import": "error",
    "import/no-webpack-loader-syntax": "error",
    "no-await-in-loop": "error",
  },
  overrides: [
    ...(governance.overrides ?? []),
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      plugins: [...nativePlugins, "typescript"],
      rules: typescriptRules,
    },
    {
      files: ["**/*.{test,spec}.{js,jsx,mjs,cjs}"],
      plugins: [...nativePlugins, "vitest"],
      rules: vitestRules,
    },
    {
      files: ["**/*.{test,spec}.{ts,tsx,mts,cts}"],
      plugins: [...nativePlugins, "typescript", "vitest"],
      rules: {
        ...vitestRules,
        "typescript/no-non-null-assertion": "off",
      },
    },
    {
      files: ["tooling/**/*.{ts,tsx,mts,cts}"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/restrict-template-expressions": "off",
      },
    },
    {
      files: ["tooling/**"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
