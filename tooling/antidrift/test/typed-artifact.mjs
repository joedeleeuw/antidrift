import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import ts from "typescript";
import plugin from "../src/eslint-plugin/index.js";

export function lintTypedArtifact({ checkout, project, file, rules }) {
  const filename = join(checkout, file);
  const configFile = join(checkout, project);
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, " "),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configFile),
  );
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, " "),
        )
        .join("\n"),
    );
  }
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
    incremental: false,
  });
  if (!program.getSourceFile(filename)) {
    throw new Error(
      `${file} is absent from the real artifact TypeScript program.`,
    );
  }
  const messages = new Linter({ cwd: checkout }).verify(
    readFileSync(filename, "utf8"),
    [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: { parser, parserOptions: { programs: [program] } },
        plugins: { antidrift: plugin },
        rules,
      },
    ],
    { filename },
  );
  return {
    messages,
    sourceFiles: program.getSourceFiles().length,
  };
}
