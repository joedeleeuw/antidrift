import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import ts from "typescript";
import plugin from "./index.js";
import corpus from "../oxlint-plugin/portable/fixtures/homer-corpus.json" with { type: "json" };

it("reports the domain-typed JSON store in the complete authenticated Homer source", () => {
  const entry = corpus.files.find(
    (file) => file.filename === "apps/api/lib/tools.ts",
  );
  expect(entry).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), "antidrift-homer-domain-"));
  try {
    const filename = join(root, entry.filename);
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename, entry.source);
    const program = ts.createProgram([filename], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
    });
    const linter = new Linter({ cwd: root });
    const messages = linter.verify(
      entry.source,
      [
        {
          files: ["**/*.ts"],
          languageOptions: { parser, parserOptions: { programs: [program] } },
          plugins: { antidrift: plugin },
          rules: { "antidrift/no-unsafe-deserialize": "error" },
        },
      ],
      { filename },
    );
    expect(
      messages.map(({ ruleId, line, column, message }) => ({
        ruleId,
        line,
        column,
        message,
      })),
    ).toEqual([
      {
        ruleId: "antidrift/no-unsafe-deserialize",
        line: 1439,
        column: 15,
        message:
          "Validate parsed JSON against the schema for 'Record<string, string>' before assigning that contract. JSON.parse validates syntax, not domain values.",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
