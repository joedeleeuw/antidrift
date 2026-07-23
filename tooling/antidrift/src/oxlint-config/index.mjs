import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defineConfig } from "oxlint";

import { loadRegistriesSync } from "../policy/lib/registries.mjs";

const packageRequire = createRequire(fileURLToPath(import.meta.url));

const nativePlugins = [
  "eslint",
  "import",
  "oxc",
  "react",
  "typescript",
  "unicorn",
];

const javascriptPlugins = [
  {
    name: "antidrift",
    specifier: fileURLToPath(
      new URL("../oxlint-plugin/index.js", import.meta.url),
    ),
  },
  {
    name: "boundaries",
    specifier: packageRequire.resolve("eslint-plugin-boundaries"),
  },
  {
    name: "eslint-comments",
    specifier: packageRequire.resolve(
      "@eslint-community/eslint-plugin-eslint-comments",
    ),
  },
];

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

export function createOxlintConfig({
  repoRoot = process.cwd(),
  policyDir = "policy",
} = {}) {
  const registries = loadRegistriesSync(resolve(repoRoot, policyDir));
  const generatedPatterns = generatedImportPatterns(registries);
  const restrictedImportPatterns = [
    ...generatedPatterns,
    ...gatewayImportPatterns(registries),
  ];

  return defineConfig({
    categories: {
      correctness: "error",
    },
    env: {
      browser: true,
      node: true,
    },
    ignorePatterns: [
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
    jsPlugins: javascriptPlugins,
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
    },
    plugins: nativePlugins,
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
      "typescript/no-explicit-any": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-extra-non-null-assertion": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-non-null-asserted-optional-chain": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-wrapper-object-types": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-enum-comparison": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-base-to-string": "error",
      "typescript/no-deprecated": "error",
      "typescript/no-namespace": "error",
      "typescript/no-require-imports": "error",
      "typescript/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "typescript/restrict-plus-operands": "error",
      "typescript/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "typescript/no-import-type-side-effects": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unnecessary-type-constraint": "error",
      "typescript/no-unnecessary-template-expression": "error",
      "typescript/no-unnecessary-type-arguments": "error",
      "typescript/no-useless-empty-export": "error",
      "typescript/prefer-find": "error",
      "typescript/prefer-function-type": "error",
      "typescript/prefer-includes": "error",
      "typescript/prefer-reduce-type-parameter": "error",
      "typescript/prefer-promise-reject-errors": "error",
      "typescript/only-throw-error": "error",
      "typescript/require-await": "error",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description" },
      ],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
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
      complexity: ["error", { max: 25, variant: "modified" }],
      "max-depth": ["error", 4],
      "max-params": ["error", { max: 7 }],
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
      "eslint-comments/require-description": "error",
      "eslint-comments/disable-enable-pair": "error",
      "eslint-comments/no-duplicate-disable": "error",
      "eslint-comments/no-unlimited-disable": "error",
      "eslint-comments/no-unused-disable": "error",
      "eslint-comments/no-unused-enable": "error",
      "antidrift/require-effect-deps": "error",
      "antidrift/no-async-array-method": "off",
      "antidrift/no-calling-components-as-functions": "off",
      "antidrift/no-duplicated-conditional-classnames": "off",
      "antidrift/no-duplicated-object-field-blocks": "off",
      "antidrift/no-handrolled-resource-lifecycle-cells": "off",
      "antidrift/no-inline-structural-type-at-use-site": "off",
      "antidrift/no-nonindependent-test-oracle": "off",
      "antidrift/no-query-data-type-parameters": "off",
      "antidrift/no-raw-fetch-in-component": "off",
      "antidrift/no-shattered-ingested-entity-state": "off",
      "antidrift/no-silent-empty-detection-fallback": "off",
      "antidrift/no-status-literal-in-type": "off",
      "antidrift/require-authz-check": "off",
      ...(restrictedImportPatterns.length > 0
        ? {
            "no-restricted-imports": restrictedImportsRule(
              restrictedImportPatterns,
            ),
          }
        : {}),
      "no-await-in-loop": "error",
    },
    overrides: [
      {
        files: ["**/*.{ts,tsx}"],
        rules: {
          "typescript/no-unnecessary-condition": [
            "error",
            { allowConstantLoopConditions: true },
          ],
        },
      },
      {
        files: ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
        plugins: [...nativePlugins, "vitest"],
        rules: {
          "typescript/no-non-null-assertion": "off",
          "vitest/expect-expect": "error",
          "vitest/no-conditional-expect": "error",
          "vitest/no-focused-tests": "error",
          "vitest/no-disabled-tests": "error",
          "vitest/no-standalone-expect": "error",
          "vitest/no-test-prefixes": "error",
          "vitest/require-to-throw-message": "error",
        },
      },
      {
        files: ["tooling/**"],
        rules: {
          "no-console": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/restrict-template-expressions": "off",
        },
      },
      ...gatewayWrapperOverrides(registries, generatedPatterns),
    ],
  });
}

export default createOxlintConfig;
