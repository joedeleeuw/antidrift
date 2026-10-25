import { resolve } from "node:path";

import parser from "@typescript-eslint/parser";
import json from "@eslint/json";
import { defineConfig } from "eslint/config";

import aiPolicy from "../eslint-plugin/index.js";
import { loadRegistriesSync } from "../policy/lib/registries.mjs";
import { templateSentinelSelectors } from "../policy/lib/property-default-fallbacks.mjs";

const ratchetedRules = {
  "antidrift/no-calling-components-as-functions": "error",
  "antidrift/no-compat-names": "error",
  "antidrift/no-duplicated-conditional-classnames": "error",
  "antidrift/no-nonindependent-test-oracle": "error",
  "antidrift/no-pass-through-parameters": "error",
  "antidrift/no-raw-fetch-in-component": "error",
  "antidrift/no-redeclared-owned-union": "error",
  "antidrift/no-sentinel-absence-fallback": "error",
  "antidrift/no-silent-empty-detection-fallback": "error",
  "antidrift/no-vague-names": "error",
};

export function createConfig({
  tsconfigRootDir = process.cwd(),
  policyDir = "policy",
  semanticFacts,
  enforceNoPropertyDefaultFallbacks = false,
} = {}) {
  const registries = loadRegistriesSync(resolve(tsconfigRootDir, policyDir));
  const generatedSources = registries.generated?.generatedSources ?? {};
  const packageTypeOwners = registries.ownership?.packageTypeOwners ?? {};
  const canonicalEntities = registries.domain?.canonicalEntities ?? {};
  const statuses = registries.domain?.statuses ?? {};

  return defineConfig(
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "reports/**",
        "docs/examples/**",
        "**/*.d.ts",
        "**/*.d.mts",
        "**/*.d.cts",
        "**/*.tsbuildinfo",
      ],
    },
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      languageOptions: {
        parser,
        parserOptions: {
          projectService: {
            allowDefaultProject: ["*.ts", "apps/*/vite.config.ts"],
            defaultProject: "./tsconfig.base.json",
          },
          tsconfigRootDir,
        },
      },
      plugins: {
        antidrift: aiPolicy,
      },
      settings: semanticFacts
        ? {
            antidrift: {
              semanticFacts,
            },
          }
        : {},
      rules: {
        "antidrift/no-contract-appeasement-projection": "error",
        "antidrift/no-bag-reshaper": "error",
        "antidrift/no-redundant-zod-parse": "error",
        "antidrift/react-max-component-props": ["error", { max: 12 }],
        "antidrift/no-unsafe-deserialize": "error",
        "antidrift/unknown-input-must-be-decoded": "error",
        "antidrift/no-appeasement-cast": "error",
        "antidrift/no-nullable-positional-tuple": "error",
        "antidrift/no-underchecked-type-predicate": "error",
        "antidrift/no-redundant-type-predicate": "error",
        "antidrift/no-defensive-shape-probing": "error",
        "antidrift/no-appeasement-erasure": "error",
        "antidrift/no-structural-type-fork": [
          "error",
          { generatedSources, packageTypeOwners, canonicalEntities },
        ],
        "antidrift/no-identity-schema-transform": "error",
        "antidrift/require-convex-return-validator": "error",
        "antidrift/no-explicit-type-arguments-on-owned-api": "error",
        "antidrift/no-schema-validator-transcoding": "error",
        "antidrift/no-unresolved-dependency-types": "error",
        "antidrift/no-wrapping-functions": "error",
        "antidrift/no-service-constructor-imports": "error",
        "antidrift/no-sql-string-concat": "error",
        ...ratchetedRules,
        "antidrift/no-redeclared-owned-union": ["error", { statuses }],
        "antidrift/no-sentinel-absence-fallback":
          enforceNoPropertyDefaultFallbacks ? "off" : "error",
        "no-restricted-syntax": [
          "error",
          ...(enforceNoPropertyDefaultFallbacks
            ? templateSentinelSelectors
            : []),
        ],
      },
    },
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      ignores: ["**/*.min.{js,mjs,cjs}"],
      languageOptions: {
        parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { antidrift: aiPolicy },
      rules: {
        ...ratchetedRules,
        "antidrift/no-redeclared-owned-union": ["error", { statuses }],
        "antidrift/no-sentinel-absence-fallback":
          enforceNoPropertyDefaultFallbacks ? "off" : "error",
        "no-restricted-syntax": [
          "error",
          ...(enforceNoPropertyDefaultFallbacks
            ? templateSentinelSelectors
            : []),
        ],
      },
    },
    {
      files: ["**/package.json"],
      language: "json/json",
      plugins: { json, antidrift: aiPolicy },
      rules: { "antidrift/no-unresolved-dependency-types": "error" },
    }
  );
}

export default createConfig;
