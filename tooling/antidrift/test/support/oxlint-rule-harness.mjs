import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import plugin from "../../src/oxlint-plugin/index.js";

export function createOxlintRuleHarness() {
  const directory = mkdtempSync(join(tmpdir(), "antidrift-oxlint-rules-"));
  const linter = new Linter({ cwd: directory });
  return {
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
    lint(name, code, filename = "component.tsx", options = {}) {
      return linter.verify(
        code,
        [
          {
            files: ["**/*.{ts,tsx,js,mjs}"],
            languageOptions: {
              parser,
              parserOptions: { ecmaFeatures: { jsx: true } },
            },
            plugins: { antidrift: plugin },
            rules: { [`antidrift/${name}`]: ["error", options] },
          },
        ],
        { filename: join(directory, filename) }
      );
    },
  };
}
