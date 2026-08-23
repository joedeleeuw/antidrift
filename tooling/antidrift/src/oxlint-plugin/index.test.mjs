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
  require(oxlintPackage).bin.oxlint,
);
const plugin = fileURLToPath(new URL("./index.js", import.meta.url));
const rawTouchableImportCases = [
  {
    label: "aliased React Native Pressable import",
    source: 'import { Pressable as NativePressable } from "react-native";',
  },
  {
    label: "legacy RNGH touchable import",
    source: 'import { TouchableOpacity } from "react-native-gesture-handler";',
  },
  {
    label: "React Native namespace import",
    source: 'import * as ReactNative from "react-native";',
  },
  {
    label: "named re-export",
    source: 'export { Pressable as Button } from "react-native";',
  },
  {
    label: "RNGH namespace re-export",
    source: 'export * from "react-native-gesture-handler";',
  },
];

const schemaLibraryImportCases = [
  'import { z } from "zod"; z.string();',
  'import * as z from "zod/v4"; z.string();',
  'const { object } = require("valibot"); object({});',
  'async function load() { return import("@effect/schema/Schema"); }',
  'import Superstruct = require("superstruct"); Superstruct.string();',
];

const validatorOracleCases = [
  'expect(UserSchema.parse(raw).id).toBe("user_1");',
  'const parsed = UserSchema.parse(raw); expect(parsed).toMatchObject({ id: "user_1" });',
  'const result = UserSchema.safeParse(raw); expect(result.success).toBe(true); expect(result.data.id).toBe("user_1");',
  "const result = UserSchema.safeParse(raw); expect(result.error.issues).toHaveLength(1);",
  'const { success, data } = UserSchema.safeParse(raw); expect(success).toBe(true); expect(data.id).toBe("user_1");',
  'expect(Object.keys(UserSchema.parse(raw))).toEqual(["id"]);',
  'expect(JSON.stringify(UserSchema.parse(raw))).toBe("{\\"id\\":\\"user_1\\"}");',
  "expect(Array.from(UserSchema.parse(raw).items)).toHaveLength(2);",
  "expect(new Set(UserSchema.parse(raw).roles).size).toBe(2);",
  'expect(UserSchema.parse(raw).items.map((item) => item.id)).toEqual(["one"]);',
  "expect(() => UserSchema.parse(raw)).toThrow();",
  'await expect(UserSchema.parseAsync(raw)).resolves.toMatchObject({ id: "user_1" });',
  'const parseUser = UserSchema.parse.bind(UserSchema); const parsed = parseUser(raw); expect(parsed.id).toBe("user_1");',
  'import { safeParse } from "valibot"; expect(safeParse(UserSchema, raw).success).toBe(true);',
  'import { decodeUnknownSync } from "effect/Schema"; expect(decodeUnknownSync(UserSchema)(raw).id).toBe("user_1");',
  'import { assert } from "superstruct"; expect(() => assert(raw, UserSchema)).not.toThrow();',
  "assert.deepEqual(UserSchema.parse(raw), expected);",
  "assert.throws(() => UserSchema.parse(raw));",
];

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
  mkdirSync(dirname(target), { recursive: true });
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

  it.each(rawTouchableImportCases)("rejects $label", ({ source }) => {
    const result = lint(source, {
      "antidrift/no-raw-react-native-touchables": "error",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("antidrift(no-raw-react-native-touchables)");
    expect(output).toMatch(/import the shared Touchable/iu);
    expect(output).toContain("choose a named feedback preset");
  });

  it("allows non-touchable platform imports and the shared primitive", () => {
    const result = lint(
      [
        'import { View } from "react-native";',
        'import { Gesture } from "react-native-gesture-handler";',
        'import { Touchable } from "@/tw";',
        'import type { TouchableOpacityProps } from "react-native";',
        'export type { TouchableOpacityProps as LegacyProps } from "react-native";',
      ].join("\n"),
      { "antidrift/no-raw-react-native-touchables": "error" },
    );

    expect(result.status).toBe(0);
  });

  it("allows raw touchable imports only in a registered owner file", () => {
    const result = lint(
      [
        'import { Pressable } from "react-native";',
        'import { Touchable } from "react-native-gesture-handler";',
      ].join("\n"),
      {
        "antidrift/no-raw-react-native-touchables": [
          "error",
          { allowedFiles: ["apps/client/src/tw/index.tsx"] },
        ],
      },
      "apps/client/src/tw/index.tsx",
    );

    expect(result.status).toBe(0);
  });

  it("rejects an underqualified owner filename", () => {
    const result = lint(
      'import { Pressable } from "react-native";',
      {
        "antidrift/no-raw-react-native-touchables": [
          "error",
          { allowedFiles: ["index.tsx"] },
        ],
      },
      "index.tsx",
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "allowedFiles entries must be exact repository-relative owner paths",
    );
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

  it.each(schemaLibraryImportCases)(
    "rejects runtime-schema value imports in tests",
    (source) => {
      const result = lint(
        source,
        { "antidrift/no-schema-library-in-test": "error" },
        "schema.test.ts",
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "antidrift(no-schema-library-in-test)",
      );
    },
  );

  it.each([
    'import type { ZodType } from "zod"; declare const schema: ZodType;',
    'import { type ZodType } from "zod"; declare const schema: ZodType;',
    'import { UserSchema } from "./contracts"; UserSchema.parse(raw);',
    'function require(name) { return fixtures[name]; } const z = require("zod");',
  ])("allows type-only, project, or shadowed imports in tests", (source) => {
    const result = lint(
      source,
      { "antidrift/no-schema-library-in-test": "error" },
      "schema.test.ts",
    );

    expect(result.status).toBe(0);
  });

  it("allows runtime-schema libraries in production files", () => {
    const result = lint(
      'import { z } from "zod"; export const UserSchema = z.object({ id: z.string() });',
      { "antidrift/no-schema-library-in-test": "error" },
      "schema.ts",
    );

    expect(result.status).toBe(0);
  });

  it.each(validatorOracleCases)(
    "rejects runtime-validator output as the assertion oracle: %s",
    (source) => {
      const result = lint(
        source,
        { "antidrift/no-validator-output-oracle": "error" },
        "schema.test.ts",
      );

      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("antidrift(no-validator-output-oracle)");
      expect(output).toContain(
        "checking parsed body or payload shapes is often a sign of a low-value test",
      );
    },
  );

  it.each([
    'expect(JSON.parse(text)).toEqual({ id: "user_1" });',
    'import YAML from "yaml"; expect(YAML.parse(text).version).toBe(2);',
    'import * as path from "node:path"; expect(path.parse(filename).ext).toBe(".ts");',
    'import * as url from "node:url"; expect(url.parse(href).hostname).toBe("example.com");',
    'import { parse as parseYaml } from "yaml"; expect(parseYaml(text).version).toBe(2);',
    'expect(renderActivation(UserSchema.parse(raw))).toBe("activation enabled");',
    'const parsed = UserSchema.parse(raw); expect(renderActivation(parsed)).toBe("activation enabled");',
    'const fixture = UserSchema.parse(raw); render(<Panel fixture={fixture} />); expect(screen.getByText("Ready")).toBeVisible();',
    "UserSchema.parse(raw); expect(handler).toHaveBeenCalledTimes(1);",
    "function parseFixture(value) { return UserSchema.parse(value); } expect(parseFixture(raw)).toEqual(expected);",
    'expect(() => startApplication(UserSchema.parse(raw))).toThrow("startup failed");',
  ])("allows non-validator application and parser assertions", (source) => {
    const result = lint(
      source,
      { "antidrift/no-validator-output-oracle": "error" },
      "schema.test.tsx",
    );

    expect(result.status).toBe(0);
  });

  it("does not inspect validator assertions outside test files", () => {
    const result = lint(
      "expect(UserSchema.parse(raw)).toEqual(raw);",
      { "antidrift/no-validator-output-oracle": "error" },
      "schema.ts",
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
