import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import ts from "typescript";
import plugin from "../src/eslint-plugin/index.js";
import proof from "./corpus/homer-json-repair.json" with { type: "json" };

export function proveHomerJson(checkout) {
  const filename = join(checkout, proof.file);
  const config = ts.readConfigFile(
    join(checkout, "apps/api/tsconfig.json"),
    ts.sys.readFile,
  );
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, " "),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(join(checkout, "apps/api/tsconfig.json")),
  );
  const original = readFileSync(filename, "utf8");
  const repaired = original.replace(
    'store = JSON.parse((await readFile(MEMORY_FILE)).toString("utf8"));',
    'store = z.record(z.string(), z.string()).parse(JSON.parse((await readFile(MEMORY_FILE)).toString("utf8")));',
  );
  if (repaired === original) {
    throw new Error("Pinned Homer repair anchor is absent.");
  }
  const result = {};
  try {
    for (const [phase, source] of [
      ["before", original],
      ["after", repaired],
    ]) {
      writeFileSync(filename, source);
      const program = ts.createProgram([filename], {
        ...parsed.options,
        noEmit: true,
        incremental: false,
      });
      const typeErrors = ts.getPreEmitDiagnostics(program);
      if (typeErrors.length) {
        throw new Error(
          `${phase}: Homer JSON proof has ${typeErrors.length} TypeScript errors.`,
        );
      }
      const linter = new Linter({ cwd: checkout });
      const messages = linter.verify(
        source,
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
      if (JSON.stringify(messages) !== JSON.stringify(proof[phase])) {
        throw new Error(
          `${phase}: Homer JSON diagnostics differ from the recorded proof.`,
        );
      }
      result[phase] = {
        typeErrors: typeErrors.length,
        findings: messages.length,
      };
    }
  } finally {
    writeFileSync(filename, original);
  }
  return result;
}
