import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const oxlintPackage = require.resolve("oxlint/package.json");
const oxlintBinary = resolve(
  dirname(oxlintPackage),
  require(oxlintPackage).bin.oxlint,
);
const plugin = fileURLToPath(new URL("./index.js", import.meta.url));
const antiSlopRuleCases = [
  {
    ruleId: "no-conditional-empty-object-spread",
    drift: "const options = { ...(enabled ? { timeout: 1 } : {}) };",
    correct:
      "const options: { timeout?: number } = {}; if (enabled) options.timeout = 1;",
  },
  {
    ruleId: "no-module-mocking",
    drift: 'import { vi } from "vitest"; vi.mock("./dependency");',
    correct: "const dependency = { run: () => 1 }; dependency.run();",
  },
  {
    ruleId: "no-object-parameters",
    drift: "function save(value: object) { return value; }",
    correct:
      "interface SaveInput { id: string } function save(value: SaveInput) { return value.id; }",
  },
  {
    ruleId: "no-reflect-apply",
    drift: "Reflect.apply(operation, owner, args);",
    correct: "operation.apply(owner, args);",
  },
  {
    ruleId: "no-reflect-get",
    drift: 'Reflect.get(user, "name");',
    correct: "user.name;",
  },
  {
    ruleId: "no-runtime-typeof",
    drift: 'if (typeof value === "string") value.length;',
    correct: 'if (value.kind === "text") value.text.length;',
  },
  {
    ruleId: "no-service-constructor-imports",
    filename: "runtime.ts",
    drift: 'import { makeClock } from "./clock";',
    correct: 'import { ClockLive } from "./clock";',
  },
  {
    ruleId: "no-shape-in-symbol-names",
    drift: "const userShape = {};",
    correct: "const userSchema = {};",
  },
  {
    ruleId: "no-unknown-parameters",
    drift: "function parse(value: unknown) { return value; }",
    correct:
      "interface ParseInput { id: string } function parse(value: ParseInput) { return value.id; }",
  },
  {
    ruleId: "no-unknown-returns",
    drift: "function load(): unknown { return data; }",
    correct:
      "interface User { id: string } declare const user: User; function load(): User { return user; }",
  },
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
  {
    ruleId: "no-unsafe-dictionary-type",
    drift: "const values: Record<string, unknown> = {};",
    correct: "const values: Record<string, string> = {};",
  },
  {
    ruleId: "require-safety-comment-for-type-assertion",
    drift: "const user = value as User;",
    correct:
      "// SAFETY: parseUser validated value before this assertion.\nconst user = value as User;",
  },
];

function lint(
  source,
  rules = { "antidrift/require-effect-deps": "error" },
  filename = "component.tsx",
) {
  const directory = mkdtempSync(join(tmpdir(), "antidrift-oxlint-plugin-"));
  const config = join(directory, ".oxlintrc.json");
  const target = join(directory, filename);
  writeFileSync(
    config,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "antidrift", specifier: plugin }],
      rules,
    }),
  );
  writeFileSync(target, source);
  const result = spawnSync(
    process.execPath,
    [oxlintBinary, "--config", config, target],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe("Oxlint plugin", () => {
  it("reports a React effect without dependencies", () => {
    const result = lint(
      'import { useEffect } from "react";\nuseEffect(() => {});\n',
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "antidrift(require-effect-deps)",
    );
  });

  it("accepts a React effect with dependencies", () => {
    const result = lint(
      'import React from "react";\nReact.useEffect(() => {}, []);\n',
    );

    expect(result.status).toBe(0);
  });

  it("runs an extracted syntax rule", () => {
    const result = lint(
      "function Panel() { fetch('/api/panel'); return <section />; }\n",
      { "antidrift/no-raw-fetch-in-component": "error" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "antidrift(no-raw-fetch-in-component)",
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
      { "antidrift/no-static-property-loop": "error" },
      "config.test.ts",
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "antidrift(no-static-property-loop)",
    );
  });

  it("accepts a behavior assertion without a static property loop", () => {
    const result = lint(
      `
        it("exposes config keys", () => {
          const rules = createConfig();
          expect(Object.keys(rules)).toStrictEqual(["first", "second"]);
        });
      `,
      { "antidrift/no-static-property-loop": "error" },
      "config.test.ts",
    );

    expect(result.status).toBe(0);
  });

  it.each(antiSlopRuleCases)(
    "reports vendored $ruleId drift",
    ({ ruleId, drift, filename = "sample.ts" }) => {
      const result = lint(
        drift,
        { [`antidrift/${ruleId}`]: "error" },
        filename,
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `antidrift(${ruleId})`,
      );
    },
  );

  it.each(antiSlopRuleCases)(
    "accepts vendored $ruleId clean code",
    ({ ruleId, correct, filename = "sample.ts" }) => {
      const result = lint(
        correct,
        { [`antidrift/${ruleId}`]: "error" },
        filename,
      );

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `antidrift(${ruleId})`,
      );
    },
  );
});
