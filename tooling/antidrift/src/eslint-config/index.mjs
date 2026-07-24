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
        "antidrift/no-appeasement-cast": "off",
        "antidrift/no-nullable-positional-tuple": "off",
        "antidrift/no-underchecked-type-predicate": "off",
        "antidrift/no-defensive-shape-probing": "off",
        "antidrift/no-structural-type-fork": "off",
        "antidrift/no-canonical-model-fork": "off",
        "antidrift/no-sql-string-concat": "off",
      },
    },
  );
}

export default createConfig;
