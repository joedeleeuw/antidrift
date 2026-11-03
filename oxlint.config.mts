import {
  createConfig as createToolingConfig,
  typescriptSyntaxRules,
  typescriptTypeAwareRules,
} from "@joedeleeuw/typescript-tooling/oxlint";
import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";

import { createOxlintConfig } from "./src/oxlint-config/index.js";

const antidrift = createOxlintConfig({
  pluginSpecifier: "./src/oxlint-plugin/index.js",
});
const tooling = createToolingConfig({
  repoRoot: import.meta.dirname,
});
const nativePlugins = ["eslint", "import", "oxc", "react", "unicorn"] as const;
const toolingBaseRules = Object.fromEntries(
  Object.entries(tooling.rules ?? {}).filter(
    ([rule]) => !rule.startsWith("typescript/")
  )
);
const typescriptRules = {
  ...typescriptSyntaxRules,
  ...typescriptTypeAwareRules,
} satisfies DummyRuleMap;

export default defineConfig({
  ...tooling,
  categories: {
    ...tooling.categories,
    correctness: "error",
  },
  env: {
    browser: true,
    node: true,
  },
  ignorePatterns: [...new Set(tooling.ignorePatterns ?? [])],
  jsPlugins: [...(tooling.jsPlugins ?? []), ...antidrift.jsPlugins],
  options: {
    ...tooling.options,
    typeAware: true,
  },
  plugins: [...nativePlugins],
  settings: {
    ...tooling.settings,
  },
  rules: {
    ...toolingBaseRules,
    ...antidrift.rules,
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
    "unicorn/no-abusive-eslint-disable": "error",
    "unicorn/no-await-in-promise-methods": "error",
    "unicorn/no-invalid-fetch-options": "error",
    "unicorn/no-single-promise-in-promise-methods": "error",
    "unicorn/no-useless-promise-resolve-reject": "error",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/require-post-message-target-origin": "error",
    curly: ["error", "multi-line"],
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
    ...(tooling.overrides ?? []),
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      plugins: [...nativePlugins, "typescript"],
      rules: typescriptRules,
    },
    {
      files: ["src/oxlint-plugin/**"],
      rules: {
        "antidrift/no-unlisted-external-imports": [
          "error",
          { allowDevDependencies: false },
        ],
      },
    },
  ],
});
