import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRequire = createRequire(import.meta.url);
const repository = resolve(import.meta.dirname, "../../../..");
const oxlintBin = join(
  dirname(packageRequire.resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);
const configPath = join(repository, "oxlint.config.mts");
let workspace;

beforeAll(() => {
  workspace = mkdtempSync(join(repository, ".oxlint-scope-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function lintProbe(filename, source) {
  const filePath = join(workspace, filename);
  writeFileSync(filePath, source);
  const result = spawnSync(
    process.execPath,
    [oxlintBin, "--config", configPath, filePath],
    {
      cwd: repository,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  return `${result.stdout}${result.stderr}`;
}

describe("root Oxlint TypeScript scopes", () => {
  it.each([
    ["module.mts", true],
    ["module.cts", true],
    ["module.mjs", false],
    ["module.cjs", false],
  ])("applies TypeScript rules to %s only when owned", (filename, expected) => {
    const output = lintProbe(
      filename,
      'const modulePath = require("node:path");\nvoid modulePath;\n',
    );

    expect(output.includes("typescript(no-require-imports)")).toBe(expected);
  });

  it.each([
    ["module.test.mts", true],
    ["module.spec.cts", true],
    ["module.test.mjs", false],
    ["module.spec.cjs", false],
  ])(
    "combines test and TypeScript rules for %s without widening JavaScript",
    (filename, typescriptExpected) => {
      const output = lintProbe(
        filename,
        [
          'const modulePath = require("node:path");',
          "void modulePath;",
          'it.only("scope", () => {});',
          "",
        ].join("\n"),
      );

      expect(output).toContain("vitest(no-focused-tests)");
      expect(output.includes("typescript(no-require-imports)")).toBe(
        typescriptExpected,
      );
    },
  );
});
