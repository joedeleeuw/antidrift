import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const oxlintPackage = require.resolve("oxlint/package.json");
const oxlintBinary = resolve(
  dirname(oxlintPackage),
  require(oxlintPackage).bin.oxlint
);
const plugin = fileURLToPath(new URL("./index.js", import.meta.url));
const packageTopEntry = fileURLToPath(new URL("../index.mjs", import.meta.url));
const antiSlopRuleCases = [
  {
    ruleId: "no-unknown-type-aliases",
    drift: "type Payload = unknown;",
    correct: "type Payload = { id: string };",
  },
  {
    ruleId: "no-unsafe-cast-chain",
    drift: "const user = input as unknown as User;",
    correct: "const user = input as User;",
  },
];

function lint(
  source,
  rules = { "antidrift/require-effect-deps": "error" },
  filename = "component.tsx",
  specifier = plugin
) {
  const directory = mkdtempSync(join(tmpdir(), "antidrift-oxlint-plugin-"));
  const config = join(directory, ".oxlintrc.json");
  const target = join(directory, filename);
  writeFileSync(
    config,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "antidrift", specifier }],
      rules,
    })
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
  const result = spawnSync(
    process.execPath,
    [oxlintBinary, "--config", config, target],
    {
      cwd: directory,
      encoding: "utf8",
    }
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe("Oxlint plugin", () => {
  it("reports a React effect without dependencies", () => {
    const result = lint(
      'import { useEffect } from "react";\nuseEffect(() => {});\n'
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      "antidrift(require-effect-deps)"
    );
  });

  it("accepts a React effect with dependencies", () => {
    const result = lint(
      'import React from "react";\nReact.useEffect(() => {}, []);\n'
    );

    expect(result.status).toBe(0);
  });

  it("runs an extracted syntax rule", () => {
    const result = lint(
      "function Panel() { fetch('/api/panel'); return <section />; }\n",
      { "antidrift/no-raw-fetch-in-component": "error" }
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      "antidrift(no-raw-fetch-in-component)"
    );
  });

  it("rejects a static property-loop test", () => {
    const result = lint(
      `
        it("repeats config properties", () => {
          const rules = createConfig();
          for (const ruleId of ["first", "second"]) {
            expect(rules[ruleId]).toBe("error");
          }
        });
      `,
      { "antidrift/no-nonindependent-test-oracle": "error" },
      "config.test.ts"
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      "antidrift(no-nonindependent-test-oracle)"
    );
  });

  it("registers through the package top entry, not only the subpath", () => {
    const result = lint(
      'import { useEffect } from "react";\nuseEffect(() => {});\n',
      { "antidrift/require-effect-deps": "error" },
      "component.tsx",
      packageTopEntry
    );
    expect(result.stdout).toMatch("antidrift(require-effect-deps)");
  });

  it("accepts a behavior assertion without a static property loop", () => {
    const result = lint(
      `
        it("exposes config keys", () => {
          const rules = createConfig();
          expect(Object.keys(rules)).toStrictEqual(["first", "second"]);
        });
      `,
      { "antidrift/no-nonindependent-test-oracle": "error" },
      "config.test.ts"
    );

    expect(result.status).toBe(0);
  });

  it("rejects assertions that only validate their own input", () => {
    const result = lint(
      'import { z } from "zod"; const User = z.object({ name: z.string() }); const input = { name: "Ada" }; expect(User.safeParse(input).success).toBe(true);',
      { "antidrift/no-nonindependent-test-oracle": "error" },
      "schema.test.ts"
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      "antidrift(no-nonindependent-test-oracle)"
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(
      "without an independent expected value"
    );
  });

  it("accepts schema output checked against independent expectations", () => {
    const result = lint(
      'import { z } from "zod"; const User = z.object({ name: z.string() }); it("parses a response", async () => { const output = await loadUser(); expect(User.parse(output)).toEqual({ name: "Ada" }); });',
      { "antidrift/no-nonindependent-test-oracle": "error" },
      "schema.test.ts"
    );

    expect(result.status).toBe(0);
  });

  it.each(antiSlopRuleCases)(
    "reports vendored $ruleId drift",
    ({ ruleId, drift, filename = "sample.ts" }) => {
      const result = lint(
        drift,
        { [`antidrift/${ruleId}`]: "error" },
        filename
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        `antidrift(${ruleId})`
      );
    }
  );

  it.each(antiSlopRuleCases)(
    "accepts vendored $ruleId clean code",
    ({ ruleId, correct, filename = "sample.ts" }) => {
      const result = lint(
        correct,
        { [`antidrift/${ruleId}`]: "error" },
        filename
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(
        `antidrift(${ruleId})`
      );
    }
  );
});
