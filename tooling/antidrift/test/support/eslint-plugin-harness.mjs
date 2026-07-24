import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import eslintPlugin from "../../src/eslint-plugin/index.js";
import oxlintPlugin from "../../src/oxlint-plugin/index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const directory = dirname(fileURLToPath(import.meta.url));

export const fixturesDir = resolve(
  directory,
  "../../src/eslint-plugin/fixtures",
);
export const plugin = {
  meta: eslintPlugin.meta,
  rules: {
    ...eslintPlugin.rules,
    ...oxlintPlugin.rules,
  },
};

export function fixture(relativePath) {
  const fullPath = resolve(fixturesDir, relativePath);
  return { code: readFileSync(fullPath, "utf8"), filename: fullPath };
}

export const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

export const typedRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      projectService: {
        allowDefaultProject: ["*.ts", "*.tsx"],
        defaultProject: resolve(fixturesDir, "tsconfig.json"),
      },
      tsconfigRootDir: fixturesDir,
    },
  },
});

export const rule = (name) => plugin.rules[name];
