import { resolve } from "node:path";

import parser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import sqlTemplate from "eslint-plugin-sql-template";

import aiPolicy from "../eslint-plugin/index.js";
import { loadRegistriesSync } from "../policy/lib/registries.mjs";

export function createConfig({
  tsconfigRootDir = process.cwd(),
  policyDir = "policy",
  semanticFacts,
} = {}) {
  const registries = loadRegistriesSync(resolve(tsconfigRootDir, policyDir));
  const generatedSources = registries.generated?.generatedSources ?? {};
  const packageTypeOwners = registries.ownership?.packageTypeOwners ?? {};
  const canonicalEntities = registries.domain?.canonicalEntities ?? {};

  return defineConfig(
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
    {
      files: ["**/*.{ts,tsx}"],
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
        "sql-template": sqlTemplate,
      },
      settings: semanticFacts
        ? {
            antidrift: {
              semanticFacts,
            },
          }
        : {},
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "TSEnumDeclaration",
            message:
              "Do not declare enums; use a union type or an as-const object so values stay structurally checkable and erase at runtime.",
          },
          {
            selector:
              'CallExpression[callee.object.name="React"][callee.property.name="forwardRef"]',
            message:
              "forwardRef is deprecated in React 19; accept ref as an ordinary prop instead.",
          },
          {
            selector: 'CallExpression[callee.name="forwardRef"]',
            message:
              "forwardRef is deprecated in React 19; accept ref as an ordinary prop instead.",
          },
        ],
        "antidrift/no-contract-appeasement-projection": "error",
        "antidrift/react-max-component-props": ["error", { max: 12 }],
        "antidrift/no-redundant-zod-parse": "error",
        "antidrift/no-unsafe-deserialize": "error",
        "antidrift/no-appeasement-cast": "error",
        "antidrift/no-nullable-positional-tuple": "error",
        "antidrift/no-underchecked-type-predicate": "warn",
        "antidrift/no-defensive-shape-probing": "warn",
        "antidrift/no-parse-as-cast": "warn",
        "antidrift/no-appeasement-erasure": "warn",
        "antidrift/no-structural-type-fork": [
          "error",
          { generatedSources, packageTypeOwners },
        ],
        "antidrift/no-canonical-model-fork": [
          "error",
          { canonicalEntities },
        ],
        // SQL surface is delegated: sql-template owns untagged interpolation,
        // CodeQL/Semgrep own cross-function taint. The retired custom rule's
        // text-shape detection flagged parameterized tagged templates.
        "sql-template/no-unsafe-query": "error",
        "antidrift/no-identity-schema-transform": "off",
        "antidrift/no-sql-string-concat": "off",
      },
    },
  );
}

export default createConfig;
