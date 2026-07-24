import { resolve } from "node:path";

import parser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

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
        "antidrift/react-max-component-props": ["error", { max: 12 }],
        "antidrift/no-redundant-zod-parse": "error",
        "antidrift/no-unsafe-deserialize": "error",
        "antidrift/no-appeasement-cast": "error",
        "antidrift/no-nullable-positional-tuple": "error",
        "antidrift/no-underchecked-type-predicate": "off",
        "antidrift/no-defensive-shape-probing": "off",
        "antidrift/no-structural-type-fork": [
          "error",
          { generatedSources, packageTypeOwners },
        ],
        "antidrift/no-canonical-model-fork": [
          "error",
          { canonicalEntities },
        ],
        "antidrift/no-sql-string-concat": "off",
      },
    },
  );
}

export default createConfig;
