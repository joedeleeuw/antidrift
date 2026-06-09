import { resolve } from "node:path";

import js from "@eslint/js";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import vitest from "@vitest/eslint-plugin";
import boundaries from "eslint-plugin-boundaries";
import importX from "eslint-plugin-import-x";
import noOnlyTests from "eslint-plugin-no-only-tests";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

import aiPolicy from "../eslint-plugin/index.js";
import { loadRegistriesSync } from "../policy/lib/registries.mjs";

function generatedImportPatterns(registries) {
  return Object.values(registries.generated?.generatedSources ?? {}).flatMap(
    ({
      bannedDirectImports = [],
      message = "Import from the approved generated-type wrapper.",
    }) => bannedDirectImports.map((group) => ({ group: [group], message })),
  );
}

function gatewayImportPatterns(registries) {
  return Object.values(registries.gateways?.approvedGateways ?? {}).flatMap(
    ({ bannedDirectImports = [], wrapper }) =>
      bannedDirectImports.map((group) => ({
        group: [group],
        message: `Import through the approved gateway wrapper (${wrapper}).`,
      })),
  );
}

function restrictedImportsRule(patterns) {
  return ["error", { patterns }];
}

function gatewayWrapperOverrides(registries, generatedPatterns) {
  return Object.values(registries.gateways?.approvedGateways ?? {})
    .filter(({ wrapper }) => typeof wrapper === "string" && wrapper.length > 0)
    .map(({ wrapper }) => ({
      files: [wrapper],
      rules: {
        "no-restricted-imports":
          generatedPatterns.length > 0
            ? restrictedImportsRule(generatedPatterns)
            : "off",
      },
    }));
}

/**
 * Shareable flat config for the AI guardrails policy.
 * @param {{ tsconfigRootDir?: string, policyDir?: string }} [options]
 *   tsconfigRootDir: consumer repo root (import.meta.dirname of its eslint.config.mjs)
 *   policyDir: path to the policy directory, relative to tsconfigRootDir (default: "policy")
 */
export function createConfig({ tsconfigRootDir, policyDir = "policy" } = {}) {
  const absPolicyDir = tsconfigRootDir
    ? resolve(tsconfigRootDir, policyDir)
    : resolve(policyDir);
  const registries = loadRegistriesSync(absPolicyDir);
  const generatedPatterns = generatedImportPatterns(registries);
  const restrictedImportPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];
  return tseslint.config(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "reports/**",
        "docs/examples/**",
        "**/fixtures/**",
        "**/*.d.ts",
        "**/*.d.mts",
        "**/*.d.cts",
        "**/*.tsbuildinfo",
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    sonarjs.configs.recommended,
    reactHooks.configs.flat["recommended-latest"],
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs}"],
      linterOptions: {
        reportUnusedDisableDirectives: "error",
      },
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: ["*.mjs", "*.ts", "apps/*/vite.config.ts"],
            defaultProject: "./tsconfig.base.json",
          },
          tsconfigRootDir,
        },
        globals: {
          ...globals.browser,
          ...globals.node,
        },
      },
      plugins: {
        boundaries,
        "@eslint-community/eslint-comments": eslintComments,
        "import-x": importX,
        "no-only-tests": noOnlyTests,
        react,
        "react-hooks": reactHooks,
        unicorn,
        antidrift: aiPolicy,
      },
      settings: {
        react: { version: "detect" },
        "import-x/extensions": [
          ".ts",
          ".tsx",
          ".mts",
          ".cts",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
        ],
        "import-x/resolver": {
          node: {
            extensions: [
              ".ts",
              ".tsx",
              ".mts",
              ".cts",
              ".js",
              ".jsx",
              ".mjs",
              ".cjs",
            ],
          },
        },
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
        // Baseline TypeScript safety: agents should fix contracts, not escape them.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-empty-object-type": "error",
        "@typescript-eslint/no-extra-non-null-assertion": "error",
        "@typescript-eslint/no-non-null-assertion": "error",
        "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
        "@typescript-eslint/no-unsafe-function-type": "error",
        "@typescript-eslint/no-wrapper-object-types": "error",
        "@typescript-eslint/no-misused-new": "error",
        "@typescript-eslint/no-misused-spread": "error",
        "@typescript-eslint/no-unsafe-declaration-merging": "error",
        "@typescript-eslint/no-duplicate-enum-values": "error",
        "@typescript-eslint/prefer-as-const": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/no-unsafe-type-assertion": "error",
        "@typescript-eslint/no-misused-promises": [
          "error",
          { checksVoidReturn: { arguments: false, attributes: false } },
        ],
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "separate-type-imports" },
        ],
        "@typescript-eslint/no-import-type-side-effects": "error",
        "@typescript-eslint/no-unnecessary-template-expression": "error",
        "@typescript-eslint/no-unnecessary-type-arguments": "error",
        "@typescript-eslint/no-useless-empty-export": "error",
        "@typescript-eslint/prefer-find": "error",
        "@typescript-eslint/prefer-function-type": "error",
        "@typescript-eslint/prefer-includes": "error",
        "@typescript-eslint/prefer-reduce-type-parameter": "error",
        "@typescript-eslint/sort-type-constituents": "error",
        "@typescript-eslint/ban-ts-comment": [
          "error",
          { "ts-expect-error": "allow-with-description" },
        ],
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],

        // React hook lifecycle rules are deterministic feedback for generated UI.
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "error",
        "react-hooks/no-deriving-state-in-effects": "error",
        "react/button-has-type": "error",
        "react/checked-requires-onchange-or-readonly": "error",
        "react/forward-ref-uses-ref": "error",
        "react/iframe-missing-sandbox": "error",
        "react/jsx-key": "error",
        "react/jsx-no-target-blank": "error",
        "react/jsx-no-duplicate-props": "error",
        "react/jsx-no-script-url": "error",
        "react/no-danger-with-children": "error",
        "react/no-unknown-property": "error",
        "react/no-children-prop": "error",
        "react/jsx-no-undef": "error",
        "react/jsx-no-comment-textnodes": "error",
        "react/jsx-filename-extension": [
          "error",
          { extensions: [".tsx", ".jsx"] },
        ],
        "react/function-component-definition": [
          "error",
          {
            namedComponents: ["arrow-function", "function-declaration"],
            unnamedComponents: ["arrow-function", "function-expression"],
          },
        ],
        "react/jsx-pascal-case": "error",
        "react/display-name": "error",
        "react/no-access-state-in-setstate": "error",
        "react/no-array-index-key": "error",
        "react/no-direct-mutation-state": "error",
        "react/no-find-dom-node": "error",
        "react/no-render-return-value": "error",
        "react/no-string-refs": "error",
        "react/no-unstable-nested-components": "error",
        "react/no-unescaped-entities": "error",
        "react/no-will-update-set-state": "error",
        "react/require-render-return": "error",
        "react/jsx-sort-props": [
          "error",
          {
            callbacksLast: true,
            reservedFirst: true,
            shorthandFirst: true,
          },
        ],

        // Focused tests are failed output.
        "no-only-tests/no-only-tests": "error",

        // Retired baseline coverage now lives in ESLint.
        "preserve-caught-error": "error",
        "no-console": "error",
        "no-debugger": "error",
        "no-array-constructor": "error",
        "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0 }],
        "no-warning-comments": [
          "error",
          { terms: ["@nocommit", "FIXME"], location: "anywhere" },
        ],
        "unicorn/no-abusive-eslint-disable": "error",
        "@eslint-community/eslint-comments/require-description": "error",
        "@eslint-community/eslint-comments/disable-enable-pair": "error",
        "@eslint-community/eslint-comments/no-duplicate-disable": "error",
        "@eslint-community/eslint-comments/no-unlimited-disable": "error",
        "@eslint-community/eslint-comments/no-unused-disable": "error",
        "@eslint-community/eslint-comments/no-unused-enable": "error",
        "unicorn/better-regex": "error",
        "unicorn/consistent-empty-array-spread": "error",
        "unicorn/custom-error-definition": "error",
        "unicorn/error-message": "error",
        "unicorn/new-for-builtins": "error",
        "unicorn/no-accessor-recursion": "error",
        "unicorn/no-await-in-promise-methods": "error",
        "unicorn/no-document-cookie": "error",
        "unicorn/no-empty-file": "error",
        "unicorn/no-hex-escape": "error",
        "unicorn/no-instanceof-builtins": "error",
        "unicorn/no-invalid-fetch-options": "error",
        "unicorn/no-invalid-remove-event-listener": "error",
        "unicorn/no-magic-array-flat-depth": "error",
        "unicorn/no-new-array": "error",
        "unicorn/no-new-buffer": "error",
        "unicorn/no-single-promise-in-promise-methods": "error",
        "unicorn/no-typeof-undefined": "error",
        "unicorn/no-unnecessary-array-flat-depth": "error",
        "unicorn/no-unnecessary-array-splice-count": "error",
        "unicorn/no-unnecessary-await": "error",
        "unicorn/no-unnecessary-slice-end": "error",
        "unicorn/no-useless-collection-argument": "error",
        "unicorn/no-useless-error-capture-stack-trace": "error",
        "unicorn/no-useless-fallback-in-spread": "error",
        "unicorn/no-useless-iterator-to-array": "error",
        "unicorn/no-useless-length-check": "error",
        "unicorn/no-useless-promise-resolve-reject": "error",
        "unicorn/no-useless-spread": "error",
        "unicorn/no-useless-switch-case": "error",
        "unicorn/no-zero-fractions": "error",
        "unicorn/numeric-separators-style": "error",
        "unicorn/prefer-add-event-listener": "error",
        "unicorn/prefer-array-flat-map": "error",
        "unicorn/prefer-array-index-of": "error",
        "unicorn/prefer-array-some": "error",
        "unicorn/prefer-date-now": "error",
        "unicorn/prefer-dom-node-append": "error",
        "unicorn/prefer-dom-node-remove": "error",
        "unicorn/prefer-dom-node-text-content": "error",
        "unicorn/prefer-keyboard-event-key": "error",
        "unicorn/prefer-native-coercion-functions": "error",
        "unicorn/prefer-negative-index": "error",
        "unicorn/prefer-node-protocol": "error",
        "unicorn/prefer-number-properties": "error",
        "unicorn/prefer-object-from-entries": "error",
        "unicorn/prefer-optional-catch-binding": "error",
        "unicorn/prefer-regexp-test": "error",
        "unicorn/prefer-set-size": "error",
        "unicorn/prefer-single-call": "error",
        "unicorn/prefer-string-raw": "error",
        "unicorn/prefer-string-slice": "error",
        "unicorn/prefer-string-starts-ends-with": "error",
        "unicorn/prefer-structured-clone": "error",
        "unicorn/prefer-ternary": "error",
        "unicorn/prefer-top-level-await": "error",
        "unicorn/prefer-type-error": "error",
        "unicorn/require-array-join-separator": "error",
        "unicorn/require-number-to-fixed-digits-argument": "error",
        "unicorn/require-post-message-target-origin": "error",
        "unicorn/text-encoding-identifier-case": "error",
        "unicorn/throw-new-error": "error",
        "sonarjs/deprecation": "error",
        "sonarjs/no-built-in-override": "error",
        "sonarjs/no-incorrect-string-concat": "error",
        "sonarjs/no-reference-error": "error",
        "sonarjs/no-undefined-assignment": "error",
        "sonarjs/no-unsafe-unzip": "error",
        curly: ["error", "multi-line"],

        // Architecture boundaries prevent semantic drift across layers.
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
        "import-x/no-cycle": ["error", { ignoreExternal: true }],
        "import-x/consistent-type-specifier-style": [
          "error",
          "prefer-top-level",
        ],
        "import-x/first": "error",
        "import-x/newline-after-import": ["error", { count: 1 }],
        "import-x/no-duplicates": "error",
        "import-x/no-absolute-path": "error",
        "import-x/no-amd": "error",
        "import-x/no-empty-named-blocks": "error",
        "import-x/no-extraneous-dependencies": [
          "error",
          {
            devDependencies: [
              "**/*.test.*",
              "**/*.spec.*",
              "**/test/**",
              "**/tests/**",
              "**/tooling/**",
              "**/*.config.*",
            ],
          },
        ],
        "import-x/no-import-module-exports": "error",
        "import-x/no-mutable-exports": "error",
        "import-x/no-named-default": "error",
        "import-x/no-relative-packages": "error",
        "import-x/no-self-import": "error",
        "import-x/no-useless-path-segments": [
          "error",
          { noUselessIndex: false },
        ],
        "import-x/no-webpack-loader-syntax": "error",
        "import-x/order": [
          "error",
          {
            groups: [
              "builtin",
              "external",
              "internal",
              ["parent", "sibling", "index"],
              "type",
            ],
            "newlines-between": "always",
            alphabetize: { order: "asc", caseInsensitive: true },
          },
        ],
        "sort-imports": [
          "error",
          {
            allowSeparatedGroups: true,
            ignoreDeclarationSort: true,
            ignoreMemberSort: false,
          },
        ],

        // AI-specific custom rules from the local plugin.
        "antidrift/no-trivial-selector-wrapper": "error",
        "antidrift/no-inline-structural-type-at-use-site": "error",
        "antidrift/no-unsafe-cast-chain": "error",
        "antidrift/no-cast-to-branded": "off",
        "antidrift/no-appeasement-cast": "error",
        "antidrift/no-nullable-positional-tuple": "error",
        "antidrift/no-underchecked-type-predicate": "error",
        "antidrift/no-defensive-shape-probing": "error",
        "antidrift/no-coupled-state-setters": "error",
        "antidrift/no-status-triplet-state": "off",
        "antidrift/require-effect-deps": "error",
        "antidrift/no-raw-tailwind-color": "error",
        "antidrift/no-hover-translate-card": "error",
        "antidrift/no-raw-fetch-in-component": "error",
        "antidrift/no-async-array-method": "error",
        "antidrift/no-obvious-comment": "off",

        // generated-type-drift: structural fork detection against installed package types (type-aware).
        "antidrift/no-structural-type-fork": [
          "error",
          { generatedSources: registries.generated?.generatedSources ?? {} },
        ],
        "antidrift/no-canonical-model-fork": [
          "error",
          { canonicalEntities: registries.domain?.canonicalEntities ?? {} },
        ],

        // validation-drift: re-parsing a value with the schema that already produced it (type-aware).
        "antidrift/no-redundant-zod-parse": "error",

        // Data-lifecycle security rules. Secret scanning is delegated to a maintained
        // scanner in consumer CI; variable-name heuristics in lint rules overreport.
        "antidrift/no-sql-string-concat": "error",
        "antidrift/no-unsafe-deserialize": "error",

        // Registry-driven rules: options are loaded from policy registries at config-construction time.
        "antidrift/no-status-literal-in-type": [
          "error",
          { statuses: registries.domain?.statuses ?? {} },
        ],
        "antidrift/no-role-literal-in-type": [
          "off",
          { roles: registries.domain?.roles ?? {} },
        ],
        ...(restrictedImportPatterns.length > 0
          ? {
              "no-restricted-imports": restrictedImportsRule(
                restrictedImportPatterns,
              ),
            }
          : {}),

        "no-await-in-loop": "error",
      },
    },
    {
      // TypeScript-only: JS policy scripts often infer option defaults too narrowly.
      files: ["**/*.{ts,tsx}"],
      rules: {
        "@typescript-eslint/no-unnecessary-condition": [
          "error",
          { allowConstantLoopConditions: true },
        ],
      },
    },
    {
      // require-authz-check: scoped to server boundaries declared in the boundaries registry.
      files: [
        "packages/*/src/routes/**/*.{ts,tsx}",
        "packages/*/src/actions/**/*.{ts,tsx}",
      ],
      rules: {
        "antidrift/require-authz-check": [
          "error",
          {
            authzFunctions: [
              ...(registries.boundaries?.requiredCalls?.authentication ?? []),
              ...(registries.boundaries?.requiredCalls?.authorization ?? []),
              ...(registries.boundaries?.requiredCalls?.tenancy ?? []),
            ],
          },
        ],
      },
    },
    ...gatewayWrapperOverrides(registries, generatedPatterns),
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
      plugins: {
        vitest,
      },
      rules: {
        ...vitest.configs.recommended.rules,
        "vitest/no-done-callback": "error",
        "vitest/no-conditional-tests": "error",
        "vitest/no-disabled-tests": "error",
        "vitest/no-conditional-in-test": "error",
        "vitest/no-test-prefixes": "error",
        "vitest/prefer-vi-mocked": "error",
        "vitest/require-to-throw-message": "error",
        "@typescript-eslint/no-non-null-assertion": "off",
        "antidrift/no-inline-structural-type-at-use-site": "off",
      },
    },
    {
      files: ["tooling/**"],
      rules: {
        "no-console": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "sonarjs/no-os-command-from-path": "off",
      },
    },
    {
      files: ["eslint.config.mjs"],
      rules: {
        "sonarjs/deprecation": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
      },
    },
  );
}

export default createConfig;
