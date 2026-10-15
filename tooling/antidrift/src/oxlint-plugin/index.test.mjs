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
  {
    label: "React Native Button import",
    source: 'import { Button } from "react-native";',
  },
  {
    label: "RNGH RectButton import",
    source: 'import { RectButton } from "react-native-gesture-handler";',
  },
  {
    label: "React Native default re-export",
    source: 'export { default as RN } from "react-native";',
  },
];

const schemaLibraryImportCases = [
  'import { z } from "zod"; z.string();',
  'import * as z from "zod/v4"; z.string();',
  'const { object } = require("valibot"); object({});',
  'async function load() { return import("@effect/schema/Schema"); }',
  'import Superstruct = require("superstruct"); Superstruct.string();',
  'import { z } from "zod"; const LocalSchema = z.object({ id: z.string() });',
  'import { z } from "zod"; const UserSchema = z.object({ id: z.string() }); expect(renderUser(UserSchema.parse(raw))).toBe("User u1");',
  'import { z } from "zod"; expect(Object.keys(z.object({ id: z.string() }).shape)).toEqual(["id"]);',
  'import { object, parse } from "valibot"; expect(renderUser(parse(object({}), raw))).toBe("User u1");',
  'import { ZodError } from "zod"; expect(() => submit(raw)).toThrow(ZodError);',
];

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
    expect(`${result.stdout}${result.stderr}`).toContain(
      "antidrift(require-effect-deps)"
    );
  });

  it("accepts a React effect with dependencies", () => {
    const result = lint(
      'import React from "react";\nReact.useEffect(() => {}, []);\n'
    );

    expect(result.status).toBe(0);
  });

  it.each(rawTouchableImportCases)(
    "rejects $label with owner advice when no owner is configured",
    ({ source }) => {
      const result = lint(source, {
        "antidrift/no-raw-react-native-touchables": "error",
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("antidrift(no-raw-react-native-touchables)");
      expect(output).toMatch(/create one shared Touchable module/iu);
      expect(output).toContain(
        "set that module as this rule's owner in allowedFiles"
      );
    }
  );

  it.each(rawTouchableImportCases)(
    "rejects $label outside the configured owner",
    ({ source }) => {
      const ownedLint = lint(source, {
        "antidrift/no-raw-react-native-touchables": [
          "error",
          { allowedFiles: ["apps/client/src/tw/index.tsx"] },
        ],
      });
      const output = `${ownedLint.stdout}${ownedLint.stderr}`;

      expect(ownedLint.status).toBe(1);
      expect(output).toContain("antidrift(no-raw-react-native-touchables)");
      expect(output).toMatch(/import the shared Touchable/iu);
      expect(output).toContain("choose a named feedback preset");
    }
  );

  it("allows non-touchable platform imports and the shared primitive", () => {
    const result = lint(
      [
        'import { View } from "react-native";',
        'import { Gesture } from "react-native-gesture-handler";',
        'import { Touchable } from "@/tw";',
        'import type { TouchableOpacityProps } from "react-native";',
        'export type { TouchableOpacityProps as LegacyProps } from "react-native";',
      ].join("\n"),
      { "antidrift/no-raw-react-native-touchables": "error" }
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
      "apps/client/src/tw/index.tsx"
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
      "index.tsx"
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "allowedFiles entries must be exact repository-relative owner paths"
    );
  });

  it("runs an extracted syntax rule", () => {
    const result = lint(
      "function Panel() { fetch('/api/panel'); return <section />; }\n",
      { "antidrift/no-raw-fetch-in-component": "error" }
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
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
      { "antidrift/no-static-property-loop": "error" },
      "config.test.ts"
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "antidrift(no-static-property-loop)"
    );
  });

  it("registers through the package top entry, not only the subpath", () => {
    const result = lint(
      'import { useEffect } from "react";\nuseEffect(() => {});\n',
      { "antidrift/require-effect-deps": "error" },
      "component.tsx",
      packageTopEntry
    );
    expect(result.stdout).toContain("antidrift(require-effect-deps)");
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
      "config.test.ts"
    );

    expect(result.status).toBe(0);
  });

  it.each(schemaLibraryImportCases)(
    "rejects runtime-schema value imports in tests",
    (source) => {
      const result = lint(
        source,
        { "antidrift/no-schema-library-in-test": "error" },
        "schema.test.ts"
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "antidrift(no-schema-library-in-test)"
      );
    }
  );

  it.each([
    'import type { ZodType } from "zod"; declare const schema: ZodType;',
    'import { type ZodType } from "zod"; declare const schema: ZodType;',
    'import { UserSchema } from "./contracts"; UserSchema.parse(raw);',
    'function require(name) { return fixtures[name]; } const z = require("zod");',
    'import { z } from "zod"; it("renders schema fields", () => expect(generateForm(z.object({ name: z.string() })).fields).toEqual(["name"]));',
    'import { z } from "zod"; const tool = defineTool({ name: "lookup", inputSchema: z.object({ id: z.string() }) }); it("runs", async () => expect(await tool.run({ id: "u1" })).toEqual({ found: true }));',
    'import { ZodError } from "zod"; it("formats", () => expect(new FormError(new ZodError([])).message).toBe("Invalid form"));',
    'import { z } from "zod"; const schema = z.object({ id: z.string() }); it("renders", () => expect(render(<Form schema={schema} />).getByRole("form")).toBeVisible());',
  ])(
    "allows type-only, project, shadowed, or application-input schema imports in tests",
    (source) => {
      const result = lint(
        source,
        { "antidrift/no-schema-library-in-test": "error" },
        "schema.test.tsx"
      );

      expect(result.status).toBe(0);
    }
  );

  it("allows runtime-schema libraries in production files", () => {
    const result = lint(
      'import { z } from "zod"; export const UserSchema = z.object({ id: z.string() });',
      { "antidrift/no-schema-library-in-test": "error" },
      "schema.ts"
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
      expect(`${result.stdout}${result.stderr}`).toContain(
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
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `antidrift(${ruleId})`
      );
    }
  );
});
