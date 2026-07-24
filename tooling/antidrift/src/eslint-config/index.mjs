import parser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

import aiPolicy from "../eslint-plugin/index.js";

export function createConfig({ tsconfigRootDir, semanticFacts } = {}) {
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
        "antidrift/no-underchecked-type-predicate": "error",
        "antidrift/no-defensive-shape-probing": "error",
        "antidrift/no-structural-type-fork": "error",
        "antidrift/no-canonical-model-fork": "error",
        "antidrift/no-sql-string-concat": "error",
      },
    },
  );
}

export default createConfig;
