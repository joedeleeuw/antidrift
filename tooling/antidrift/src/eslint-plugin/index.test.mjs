import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import plugin from "./index.js";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
const repoRoot = resolve(__dirname, "../../../..");
const semanticFactKinds = YAML.parse(
  readFileSync(resolve(repoRoot, "policy/registries/rules.yaml"), "utf8"),
).semanticFactKinds;

function fixture(relativePath) {
  const fullPath = resolve(fixturesDir, relativePath);
  return { code: readFileSync(fullPath, "utf8"), filename: fullPath };
}

function expectFactMatchesRegistry(fact) {
  const entry = semanticFactKinds[fact.factKind];
  expect(entry).toBeDefined();
  expect(entry.rules).toContain(fact.ruleId);
  expect(fact.adapterId).toBe(entry.adapterId);
  expect(entry.confidence).toContain(fact.confidence);
  for (const field of entry.payloadFields) {
    expect(fact.payload).toHaveProperty(field);
  }
}

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

// Type-aware tester: uses real firebase + zod types via the fixtures tsconfig.
// The rule enumerates canonical types from the program (which loads firebase because a
// sibling fixture imports it), so no settings/index plumbing is needed.
const typedRuleTester = new RuleTester({
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

const typeServiceMessage = /requires TypeScript parser services/u;
const rule = (name) => plugin.rules[name];
const typeServiceGuardedRules = [
  "react-max-component-props",
  "no-appeasement-cast",
  "no-canonical-model-fork",
  "no-contract-appeasement-projection",
  "no-defensive-shape-probing",
  "no-redundant-zod-parse",
  "no-structural-type-fork",
  "no-underchecked-type-predicate",
  "no-unsafe-deserialize",
];

for (const guardedRule of typeServiceGuardedRules) {
  ruleTester.run(`${guardedRule} type-service guard`, rule(guardedRule), {
    valid: [],
    invalid: [
      {
        code: "declare const value: any; value;",
        errors: [{ message: typeServiceMessage }],
      },
    ],
  });
}

typedRuleTester.run(
  "react-max-component-props",
  rule("react-max-component-props"),
  {
    valid: [
      {
        code: `
          interface PanelProps {
            title: string;
            subtitle: string;
            disabled?: boolean;
          }

          export function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          }
        `,
        options: [{ max: 3 }],
      },
      {
        code: `
          interface LoaderInput {
            a: string;
            b: string;
            c: string;
            d: string;
            e: string;
          }

          export function load(input: LoaderInput) {
            return input.a;
          }
        `,
        options: [{ max: 3 }],
      },
      {
        code: `
          import type { ComponentProps } from "react";

          type ButtonProps = ComponentProps<"button"> & {
            tone?: "primary" | "secondary";
            size?: "sm" | "lg";
          };

          export function Button(props: ButtonProps) {
            return <button {...props} />;
          }
        `,
        options: [{ max: 2 }],
      },
      {
        code: `
          type BaseProps = {
            one: string;
            two: string;
            three: string;
            four: string;
          };

          const Base = (_props: BaseProps) => null;

          export function Wrapper(props: BaseProps) {
            return <Base {...props} />;
          }
        `,
        options: [{ max: 3 }],
      },
    ],
    invalid: [
      {
        code: `
          interface PanelProps {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          }

          export function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          }
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
      },
      {
        code: `
          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
            onSelect(): void;
          };

          export const Panel = ({ title }: PanelProps) => <section>{title}</section>;
        `,
        options: [{ max: 4 }],
        errors: [{ message: /too many locally-owned props \(5 > 4\)/u }],
      },
      {
        code: `
          import type { FC } from "react";

          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          };

          export const Panel: FC<PanelProps> = (props) => <section>{props.title}</section>;
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
      },
      {
        code: `
          import { memo } from "react";

          type PanelProps = {
            title: string;
            subtitle: string;
            status: string;
            count: number;
          };

          export const Panel = memo(function Panel(props: PanelProps) {
            return <section>{props.title}</section>;
          });
        `,
        options: [{ max: 3 }],
        errors: [{ message: /too many locally-owned props \(4 > 3\)/u }],
      },
    ],
  },
);

ruleTester.run("no-async-array-method", rule("no-async-array-method"), {
  valid: [
    fixture("programs/correct/async-map-promise-all.ts"),
    fixture("programs/correct/async-map-delayed-promise-all.ts"),
    {
      ...fixture("programs/correct/async-map-promise-all.ts"),
      options: [{ branches: ["requires-collection"] }],
    },
    {
      ...fixture("programs/correct/async-map-delayed-promise-all.ts"),
      options: [{ branches: ["requires-collection"] }],
    },
    {
      code: "async function load(ids) { return ids.map(async (id) => fetch(id)); }",
      options: [{ branches: ["requires-collection"] }],
    },
    {
      code: "async function load(ids) { const pending = ids.map(async (id) => fetch(id)); return pending; }",
      options: [{ branches: ["requires-collection"] }],
    },
    {
      code: "const load = (ids) => ids.map(async (id) => fetch(id));",
      options: [{ branches: ["requires-collection"] }],
    },
    {
      code: "async function load(ids, ok) { return ok ? ids.map(async (id) => fetch(id)) : []; }",
      options: [{ branches: ["requires-collection"] }],
    },
    fixture("programs/drift/async-map-without-promise-all.ts"),
    "items.map((i) => i + 1);",
    "async function f() { for (const i of items) { await work(i); } }",
  ],
  invalid: [
    {
      code: "async function load(ids) { const pending = ids.map(async (id) => fetch(id)); return pending.length; }",
      options: [{ branches: ["requires-collection"] }],
      errors: 1,
    },
    {
      code: "async function load(ids) { const pending = ids.map(async (id) => fetch(id)); return pending.length; }",
      options: [{ branches: ["never-await", "requires-collection"] }],
      errors: 1,
    },
    { ...fixture("programs/drift/async-foreach-callback.ts"), errors: 1 },
    {
      ...fixture("programs/drift/async-foreach-callback.ts"),
      options: [{ branches: ["requires-collection"] }],
      errors: 1,
    },
    { ...fixture("programs/drift/async-filter-callback.ts"), errors: 1 },
  ],
});

ruleTester.run("require-effect-deps", rule("require-effect-deps"), {
  valid: [
    fixture("programs/correct/effect-empty-deps.ts"),
    fixture("programs/correct/effect-with-deps.ts"),
    'import { useLayoutEffect } from "react"; useLayoutEffect(() => {}, []);',
    'import { useEffect as ue } from "react"; ue(() => {}, [x]);',
    'import React from "react"; React.useEffect(() => {}, [x]);',
    'import * as React from "react"; React.useEffect(() => {}, [x]);',
    // Different react hook — not an effect hook
    'import { useState } from "react"; useState(0);',
    // Not imported from react — out of scope, do not flag
    "useEffect(() => {});",
    // useEffect from a non-react module is not the React hook
    'import { useEffect } from "./mine"; useEffect(() => {});',
  ],
  invalid: [
    { ...fixture("programs/drift/effect-missing-deps-direct.ts"), errors: 1 },
    {
      code: 'import { useLayoutEffect } from "react"; useLayoutEffect(() => {});',
      errors: 1,
    },
    {
      code: 'import { useEffect as ue } from "react"; ue(() => {});',
      errors: 1,
    },
    {
      code: 'import React from "react"; React.useEffect(() => {});',
      errors: 1,
    },
    {
      code: 'import * as React from "react"; React.useEffect(() => {});',
      errors: 1,
    },
    { ...fixture("programs/drift/effect-missing-deps.ts"), errors: 1 },
  ],
});

ruleTester.run(
  "no-calling-components-as-functions",
  rule("no-calling-components-as-functions"),
  {
    valid: [
      "function lower() {} lower();",
      "const BREAKPOINTS = () => {}; BREAKPOINTS();",
      'import { Schema } from "effect"; Schema.Struct({ id: 1 });',
      'import { Widget } from "./w"; const ref = Widget;',
      "unknownThing({ a: 1 });",
    ],
    invalid: [
      {
        code: "function Widget() { return null; } Widget({ label: 'x' });",
        output: "function Widget() { return null; } <Widget label={'x'} />;",
        errors: 1,
      },
      {
        code: 'import { Card } from "./c"; Card();',
        output: 'import { Card } from "./c"; <Card />;',
        errors: 1,
      },
      {
        code: "const Box = () => null; Box({ a: 1 });",
        output: "const Box = () => null; <Box a={1} />;",
        errors: 1,
      },
    ],
  },
);

const duplicatedClassnameControls = {
  attributes: ["class", "className"],
  helpers: [],
  minSharedRatio: 0.65,
  minSharedTokens: 4,
};

ruleTester.run(
  "no-duplicated-conditional-classnames",
  rule("no-duplicated-conditional-classnames"),
  {
    valid: [
      {
        code: `
          <Pressable
            className={cn(
              "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3",
              sendDisabled ? "opacity-50" : "active:opacity-75",
            )}
          />;
        `,
        filename: "new-thread.tsx",
      },
      {
        code: `
          <Pressable
            className={\`h-9 items-center justify-center rounded-lg border border-mb-border-strong bg-mb-surface px-3 active:opacity-75 \${runtimeStatus.isFetching ? "opacity-50" : ""}\`}
          />;
        `,
        filename: "runtime-diagnostics.tsx",
      },
      {
        code: `
          <Pressable
            className={
              sendDisabled
                ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
                : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75"
            }
          />;
        `,
        filename: "new-thread.tsx",
        options: [{ ...duplicatedClassnameControls, minSharedRatio: 0.95 }],
      },
      {
        code: `
          cx(
            sendDisabled
              ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
              : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75",
          );
        `,
        filename: "new-thread.tsx",
      },
      {
        code: `
          cn(
            sendDisabled
              ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
              : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75",
          );
        `,
        filename: "new-thread.tsx",
      },
    ],
    invalid: [
      {
        code: `
          <Pressable
            className={
              sendDisabled
                ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
                : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75"
            }
          />;
        `,
        filename: "new-thread.tsx",
        errors: [{ messageId: "duplicatedConditionalClassnames" }],
      },
      {
        code: `
          <Pressable
            className={cn(
              sendDisabled
                ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
                : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75",
            )}
          />;
        `,
        filename: "new-thread.tsx",
        errors: [{ messageId: "duplicatedConditionalClassnames" }],
      },
      {
        code: `
          <Pressable
            tw={
              sendDisabled
                ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
                : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75"
            }
          />;
        `,
        filename: "new-thread.tsx",
        options: [{ ...duplicatedClassnameControls, attributes: ["tw"] }],
        errors: [{ messageId: "duplicatedConditionalClassnames" }],
      },
      {
        code: `
          cx(
            sendDisabled
              ? "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 opacity-50"
              : "w-full flex-row items-center gap-2.5 rounded-[12px] bg-mb-surface-2 px-3.5 py-3 active:opacity-75",
          );
        `,
        filename: "new-thread.tsx",
        options: [{ ...duplicatedClassnameControls, helpers: ["cx"] }],
        errors: [{ messageId: "duplicatedConditionalClassnames" }],
      },
    ],
  },
);

it("fails loud on partial duplicated classname controls", async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.tsx"],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 2023,
          sourceType: "module",
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { antidrift: plugin },
        rules: {
          "antidrift/no-duplicated-conditional-classnames": [
            "error",
            { minSharedRatio: 0.95 },
          ],
        },
      },
    ],
  });

  await expect(
    eslint.lintText(
      `<Pressable className={ok ? "a b c d e" : "a b c d f"} />;`,
      { filePath: "component.tsx" },
    ),
  ).rejects.toThrow(/attributes/u);
});

ruleTester.run(
  "no-duplicated-object-field-blocks",
  rule("no-duplicated-object-field-blocks"),
  {
    valid: [
      {
        code: `
          const transcriptItemFields = {
            item_id: z.string(),
            content_index: z.number(),
          };

          z.discriminatedUnion("type", [
            z.object({
              type: z.literal("conversation.item.input_audio_transcription.completed"),
              ...transcriptItemFields,
              transcript: z.string(),
            }).passthrough(),
            z.object({
              type: z.literal("response.output_audio_transcript.delta"),
              ...transcriptItemFields,
              delta: z.string(),
            }).passthrough(),
            z.object({
              type: z.literal("response.output_audio_transcript.done"),
              ...transcriptItemFields,
              transcript: z.string(),
            }).passthrough(),
          ]);
        `,
      },
      {
        code: `
          z.object({ type: z.literal("created"), id: z.string(), at: z.number() });
          z.object({ type: z.literal("updated"), id: z.string(), at: z.number() });
        `,
      },
      {
        code: `
          z.object({ id: z.string(), content_index: z.number() });
          z.object({ id: z.number(), content_index: z.string() });
          z.object({ id: z.boolean(), content_index: z.bigint() });
        `,
      },
      {
        code: `
          interface TranscriptItemFields {
            itemId: string;
            contentIndex: number;
          }

          interface TranscriptDelta extends TranscriptItemFields {
            kind: "delta";
            delta: string;
          }

          type TranscriptDone = TranscriptItemFields & {
            kind: "done";
            transcript: string;
          };
        `,
      },
      {
        code: `
          const first = { id: parseId(), contentIndex: parseIndex(), label: "first" };
          const second = { id: parseId(), contentIndex: parseIndex(), label: "second" };
          const third = { id: parseId(), contentIndex: parseIndex(), label: "third" };
        `,
      },
    ],
    invalid: [
      {
        code: `
          z.discriminatedUnion("type", [
            z.object({
              type: z.literal("conversation.item.input_audio_transcription.completed"),
              item_id: z.string(),
              content_index: z.number(),
              transcript: z.string(),
            }).passthrough(),
            z.object({
              type: z.literal("response.output_audio_transcript.delta"),
              response_id: z.string(),
              item_id: z.string(),
              content_index: z.number(),
              delta: z.string(),
            }).passthrough(),
            z.object({
              type: z.literal("response.output_audio_transcript.done"),
              response_id: z.string(),
              item_id: z.string(),
              content_index: z.number(),
              transcript: z.string(),
            }).passthrough(),
          ]);
        `,
        errors: [
          {
            messageId: "duplicatedObjectFieldBlocks",
            data: {
              shapes: "3",
              count: "2",
              fields: "content_index, item_id",
            },
          },
        ],
      },
      {
        code: `
          z.object({ kind: z.literal("left"), id: z.string(), at: z.number(), source: z.string() });
          z.object({ kind: z.literal("right"), id: z.string(), at: z.number(), source: z.string() });
        `,
        errors: [
          {
            messageId: "duplicatedObjectFieldBlocks",
            data: { shapes: "2", count: "3", fields: "at, id, source" },
          },
        ],
      },
      {
        code: `
          type Created = { kind: "created"; id: string; contentIndex: number };
          type Updated = { kind: "updated"; id: string; contentIndex: number };
          type Deleted = { kind: "deleted"; id: string; contentIndex: number };
        `,
        errors: [
          {
            messageId: "duplicatedObjectFieldBlocks",
            data: {
              shapes: "3",
              count: "2",
              fields: "contentIndex, id",
            },
          },
        ],
      },
      {
        code: `
          z.object({ kind: z.literal("a"), id: z.string(), at: z.number(), tenant: z.string(), source: z.string(), region: z.string(), locale: z.string() });
          z.object({ kind: z.literal("b"), id: z.string(), at: z.number(), tenant: z.string(), source: z.string(), region: z.string(), locale: z.string() });
          z.object({ kind: z.literal("c"), id: z.string(), at: z.number() });
        `,
        errors: [
          {
            messageId: "duplicatedObjectFieldBlocks",
            data: { shapes: "3", count: "2", fields: "at, id" },
          },
        ],
      },
      {
        code: `
          z.object({ kind: z.literal("a"), id: z.string(), at: z.number(), tenant: z.string(), source: z.string(), region: z.string(), locale: z.string(), zone: z.string() });
          z.object({ kind: z.literal("b"), id: z.string(), at: z.number(), tenant: z.string(), source: z.string(), region: z.string(), locale: z.string(), zone: z.string() });
          z.object({ kind: z.literal("c"), id: z.string(), at: z.number() });
        `,
        errors: [
          {
            messageId: "duplicatedObjectFieldBlocks",
            data: { shapes: "3", count: "2", fields: "at, id" },
          },
        ],
      },
    ],
  },
);

it("fails loud on partial duplicated object field block controls", async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 2023,
          sourceType: "module",
        },
        plugins: { antidrift: plugin },
        rules: {
          "antidrift/no-duplicated-object-field-blocks": [
            "error",
            { minSharedFields: 2, minShapes: 2 },
          ],
        },
      },
    ],
  });

  await expect(
    eslint.lintText(
      `type A = { id: string; at: number }; type B = { id: string; at: number };`,
      { filePath: "types.ts" },
    ),
  ).rejects.toThrow(/minRedundantDeclarations/u);
});

ruleTester.run(
  "no-nonindependent-test-oracle",
  rule("no-nonindependent-test-oracle"),
  {
    valid: [
      {
        code: 'assert.deepEqual(renderConfig(registry), { mcpServers: { executor: { url: "http://executor" } } });',
        filename: "registry.test.ts",
      },
      {
        code: 'expect(screen.getByRole("button", { name: "Save" })).toBeVisible();',
        filename: "ui.test.tsx",
      },
      {
        code: 'expect(result).toHaveProperty("summary", "2 items");',
        filename: "registry.test.ts",
      },
      {
        code: 'function hasExecutor(names) { return names.includes("executor"); }',
        filename: "registry.ts",
      },
      {
        code: 'names.not.toContain("node_repl");',
        filename: "registry.test.ts",
      },
      {
        code: `
          it("finds the needle connection", () => {
            const needle = connections.find((server) => server.name === "needle");
            expect(needle).toBeDefined();
            expect(needle.transport).toBe("stdio");
          });
        `,
        filename: "registry.test.ts",
      },
      {
        code: `
          it("debounces the handler", () => {
            trigger();
            trigger();
            expect(handler).toHaveBeenCalledTimes(1);
          });
        `,
        filename: "debounce.test.ts",
      },
      {
        code: `
          it("round-trips through serialize", () => {
            expect(deserialize(serialize(payload))).toEqual(payload);
          });
        `,
        filename: "codec.test.ts",
      },
    ],
    invalid: [
      {
        code: 'assert.equal(names.includes("node_repl"), false);',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: 'assert.deepStrictEqual(names.includes("node_repl"), false);',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: 'assert.ok(!("node_repl" in config.mcp_servers));',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: 'assert.equal(registry.mcpServers.some((server) => server.name === "node_repl"), false);',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: "expect(frames.some((frame) => frame.proof.proven)).toBe(true);",
        filename: "react-state-graph.test.mjs",
        errors: 1,
      },
      {
        code: "expect(frames.some((frame) => frame.proof.proven)).toStrictEqual(true);",
        filename: "react-state-graph.test.mjs",
        errors: 1,
      },
      {
        code: 'expect(names).not.toContain("node_repl");',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: 'expect(config.mcp_servers).toHaveProperty("executor");',
        filename: "registry.test.ts",
        errors: 1,
      },
      {
        code: 'assert.equal(Object.hasOwn(renderConfig(registry).mcpServers, "expo"), false);',
        filename: "registry.test.ts",
        errors: [{ messageId: "noBareMembership" }],
      },
      {
        code: `
          const codexThreadSummary = { status: "running", source: { kind: "provider-thread" } };
          it("parses canonical agent thread summaries", () => {
            const parsed = agentThreadSummarySchema.parse(codexThreadSummary);
            expect(parsed.status).toBe("running");
            expect(parsed.source.kind).toBe("provider-thread");
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "inputEcho" }, { messageId: "inputEcho" }],
      },
      {
        code: `
          const codexThreadSummary = { status: "running" };
          it("rejects malformed agent thread summaries loudly", () => {
            expect(schema.safeParse({ ...codexThreadSummary, status: "streaming" }).success).toBe(false);
            expect(schema.safeParse({ ...codexThreadSummary, extra: true }).success).toBe(false);
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "outcomeEcho" }, { messageId: "outcomeEcho" }],
      },
      {
        code: `
          const fixture = { status: "running" };
          it("proves a transform beside the echo", () => {
            const parsed = schema.parse(fixture);
            expect(parsed).toEqual(fixture);
            expect(renderSummary(parsed)).toBe("running thread");
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "inputEcho" }],
      },
      {
        code: `
          const fixture = { status: "running" };
          it("rejects malformed payloads with issue detail", () => {
            const result = schema.safeParse(fixture);
            expect(result.success).toBe(false);
            expect(result.error.issues[0].path).toEqual(["status"]);
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "outcomeEcho" }],
      },
      {
        code: `
          it("echoes the parse result", () => {
            const parsed = schema.parse(fixture);
            expect(parsed).toEqual(fixture);
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "inputEcho" }],
      },
      {
        code: `
          it("echoes one field back", () => {
            const parsed = schema.parse(fixture);
            expect(parsed.status).toBe(fixture.status);
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "inputEcho" }],
      },
      {
        code: `
          it("parses thread list responses", () => {
            const parsed = listSchema.parse({ items: [codexThreadSummary, claudeThreadSummary], hasMore: true, limit: 2 });
            expect(parsed.items).toHaveLength(2);
            expect(listSchema.safeParse({ items: [codexThreadSummary], hasMore: "yes" }).success).toBe(false);
          });
        `,
        filename: "thread.test.ts",
        errors: [{ messageId: "lengthEcho" }, { messageId: "outcomeEcho" }],
      },
      {
        code: `
          const registryInput = { agentSurfaces: [{ kind: "a" }, { kind: "b" }, { kind: "c" }] };
          it("projects surface kinds", () => {
            const registry = parseRegistry(registryInput);
            expect(registry.agentSurfaces.length).toBe(3);
            expect(registry.agentSurfaces.map((surface) => surface.kind)).toEqual(["a", "b", "c"]);
          });
        `,
        filename: "registry.test.ts",
        errors: [{ messageId: "lengthEcho" }],
      },
      {
        code: `
          it("checks runtime servers", () => {
            const connections = toRuntimeConnections(registry);
            expect(connections.map((server) => server.name)).toEqual(["needle", "context7"]);
            expect(names).toContain("executor");
          });
        `,
        filename: "registry.test.ts",
        errors: [{ messageId: "noBareMembership" }],
      },
      {
        code: `
          it("saves through the repository", () => {
            service.save(user);
            expect(repository.save).toHaveBeenCalledWith(user);
          });
        `,
        filename: "service.test.ts",
        errors: [{ messageId: "mockCallEcho" }],
      },
      {
        code: `
          it("has config", () => {
            const config = { retries: 3 };
            expect(config).toBeDefined();
          });
        `,
        filename: "config.test.ts",
        errors: [{ messageId: "existenceEcho" }],
      },
    ],
  },
);

ruleTester.run(
  "no-query-data-type-parameters",
  rule("no-query-data-type-parameters"),
  {
    valid: [
      'queryClient.getQueryData(["k"]);',
      'queryClient.setQueryData(["k"], 1);',
      'other.getData<number>(["k"]);',
      'getQueryData<number>(["k"]);',
    ],
    invalid: [
      { code: 'queryClient.getQueryData<number>(["count"]);', errors: 1 },
      {
        code: 'client.setQueryData<{ a: number }>(["k"], { a: 1 });',
        errors: 1,
      },
    ],
  },
);

ruleTester.run(
  "no-silent-empty-detection-fallback",
  rule("no-silent-empty-detection-fallback"),
  {
    valid: [
      "function formatLabel() { try { return readLabel(); } catch { return ''; } }",
      "function macosPlatformUuid() { const match = output.match(/UUID/); if (!match) throw new Error('missing UUID'); return match[1]; }",
      "const resolveHost = () => null;",
      "const deviceId = () => process.env.AGENT_TRACE_DEVICE_ID ?? readMachineId();",
      "function getDisplayName() { return ''; }",
      "function isValid() { return ''; }",
    ],
    invalid: [
      {
        code: `function macosPlatformUuid() {
          if (process.platform !== "darwin") return "";
          try {
            const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
            return output.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] || "";
          } catch {
            return "";
          }
        }`,
        errors: [
          {
            message:
              "Do not return an empty string from macosPlatformUuid (source: ast-failure-branch). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
          {
            message:
              "Do not return an empty string from macosPlatformUuid (source: ast-logical-fallback). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
          {
            message:
              "Do not return an empty string from macosPlatformUuid (source: ast-catch-recovery). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
      {
        code: "const deviceId = () => process.env.AGENT_TRACE_DEVICE_ID ?? '';",
        errors: [
          {
            message:
              "Do not return an empty string from deviceId (source: ast-logical-fallback). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
      {
        code: "const detector = { lookupHost() { return ok ? host : ''; } };",
        errors: [
          {
            message:
              "Do not return an empty string from lookupHost (source: ast-conditional-fallback). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
      {
        code: "function traceDevice() { return (readMachineId() || '') as string; }",
        errors: [
          {
            message:
              "Do not return an empty string from traceDevice (source: ast-logical-fallback). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
    ],
  },
);

typedRuleTester.run(
  "no-contract-appeasement-projection",
  rule("no-contract-appeasement-projection"),
  {
    valid: [
      fixture("programs/correct/exported-function-selector-boundary.ts"),
      fixture("programs/correct/contract-projection-boundaries.ts"),
      fixture("programs/correct/selector-computation.ts"),
      fixture("programs/correct/inferred-selector-wrapper.ts"),
      fixture("programs/correct/selector-returns-foreign-object.ts"),
      fixture("programs/correct/selector-this-member.ts"),
      fixture("programs/correct/destructured-param-computation.ts"),
      // Public methods of an exported class are a boundary; type-level/abstract signatures need explicit types
      fixture("programs/correct/methods-public-boundary.ts"),
      fixture("programs/correct/methods-interface-and-abstract.ts"),
      fixture("programs/correct/exported-object-boundary.ts"),
      fixture("programs/correct/returned-object-boundary.ts"),
      fixture("programs/correct/private-boolean-predicate-helper.ts"),
    ],
    invalid: [
      { ...fixture("programs/drift/typed-selector-wrapper.ts"), errors: 1 },
      {
        ...fixture("programs/drift/contract-appeasement-projection.ts"),
        errors: 3,
      },
      {
        ...fixture("programs/drift/typed-selector-arrow-wrapper.ts"),
        errors: 1,
      },
      {
        ...fixture("programs/drift/typed-nested-selector-wrapper.ts"),
        errors: 1,
      },
      // Same wrapper as a method on an internal class must be caught too
      {
        ...fixture("programs/drift/methods-internal-appeasement.ts"),
        errors: 3,
      },
      { ...fixture("programs/drift/object-literal-appeasement.ts"), errors: 1 },
      {
        ...fixture("programs/drift/destructured-param-selector-wrapper.ts"),
        errors: 2,
      },
    ],
  },
);

typedRuleTester.run("no-appeasement-cast", rule("no-appeasement-cast"), {
  valid: [
    fixture("programs/correct/narrow-then-assign.ts"),
    fixture("programs/correct/plain-cast.ts"),
    fixture("programs/correct/brand-validation-boundary.ts"),
    fixture("programs/correct/json-parse-result-schema-parse.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/appeasement-cast.ts"), errors: 2 },
    { ...fixture("programs/drift/json-parse-result-cast.ts"), errors: 1 },
  ],
});

typedRuleTester.run(
  "no-defensive-shape-probing",
  rule("no-defensive-shape-probing"),
  {
    valid: [
      fixture("programs/correct/owned-type-guard-or-schema.ts"),
      fixture("programs/correct/narrow-then-assign.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/object-entries-shape-probing.ts"),
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run(
  "no-underchecked-type-predicate",
  rule("no-underchecked-type-predicate"),
  {
    valid: [
      "type TriggerTitle = { title: string; subtitle?: string; args?: string[] };\nconst isTriggerTitle = (value: any): value is TriggerTitle => typeof value === 'object' && value !== null && 'title' in value;",
      "type OptionalDisplay = { titleClass?: string; subtitleClass?: string };\nconst isOptionalDisplay = (value: unknown): value is OptionalDisplay => typeof value === 'object' && value !== null;",
      "type DateMessage = { year: number; month: number; day: number };\nfunction isDateMessage(value: unknown): value is DateMessage { return typeof value === 'object' && value !== null && 'year' in value && 'month' in value && 'day' in value; }",
      "import { z } from 'zod';\nconst UserSchema = z.object({ id: z.string(), email: z.string(), role: z.string() });\ntype User = z.infer<typeof UserSchema>;\nfunction isUser(value: unknown): value is User { return UserSchema.safeParse(value).success; }",
      "function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }",
    ],
    invalid: [
      {
        code: "type User = { id: string; email: string; active?: boolean };\nfunction isUser(value: unknown): value is User { return typeof value === 'object' && value !== null && 'id' in value; }",
        errors: 1,
      },
      {
        code: "type User = { id: string; email: string };\nfunction isUser(value: unknown): value is User { return typeof value === 'object' && value !== null; }",
        errors: 1,
      },
      {
        code: "type User = { id: string; email: string; role: string; active?: boolean };\nfunction isUser(value: unknown): value is User { return typeof value === 'object' && value !== null && 'id' in value && 'email' in value; }",
        errors: 1,
      },
      {
        code: "type User = { id: string; email: string; role: string };\ndeclare function validateUser(value: unknown): boolean;\nfunction isUser(value: unknown): value is User { return validateUser(value); }",
        errors: 1,
      },
    ],
  },
);

ruleTester.run(
  "no-handrolled-resource-lifecycle-cells",
  rule("no-handrolled-resource-lifecycle-cells"),
  {
    valid: [
      fixture("programs/correct/single-state-setter-handler.ts"),
      fixture("programs/correct/sibling-payload-setters.ts"),
      fixture("programs/correct/sibling-component-setter-scope.ts"),
      // Synchronous multi-setter UI cleanup is not a lifecycle machine.
      fixture("programs/correct/multi-setter-ui-cleanup.ts"),
      // Loading + data with no error/catch cell: stale-while-revalidate.
      fixture("programs/correct/stale-while-revalidate.ts"),
      // Append via updater fn is incremental pagination, not a fresh resource load.
      fixture("programs/correct/pagination-next-page.ts"),
      // Full lifecycle shape, but request-identity guarded by AbortController.
      fixture("programs/correct/abort-guarded-fetch.ts"),
      // Owned resource hook: no local useState cells to couple.
      fixture("programs/correct/owned-resource-hook.ts"),
      // Request guard constructed at component scope (useRef) still exempts the transition.
      fixture("programs/correct/abort-guarded-component-scope.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/handrolled-resource-lifecycle.ts"),
        errors: 1,
      },
    ],
  },
);

const generatedStructuralOptions = {
  generatedSources: {
    fixtureGenerated: {
      generated: "programs/generated",
    },
  },
};

typedRuleTester.run(
  "no-shattered-ingested-entity-state",
  rule("no-shattered-ingested-entity-state"),
  {
    valid: [
      {
        code: `
          import { useState } from "react";
          declare namespace JSX { interface IntrinsicElements { input: any; form: any; } }
          declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
          function ProfileForm() {
            const [id, setId] = useState("");
            const [name, setName] = useState("");
            async function load() {
              const profile = await fetchProfile();
              setId(profile.id);
              setName(profile.displayName);
            }
            return <form>
              <input value={id} onChange={(event) => setId(event.currentTarget.value)} />
              <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
            </form>;
          }
          void ProfileForm;
        `,
        filename: "profile-form.tsx",
      },
      `
        import { useState } from "react";
        declare function fetchUser(): Promise<{ id: string; name: string }>;
        function UserPanel() {
          const [user, setUser] = useState<{ id: string; name: string } | null>(null);
          return async function load() {
            const next = await fetchUser();
            setUser(next);
          };
        }
        void UserPanel;
      `,
      `
        import { useState } from "react";
        declare function fetchUser(): Promise<{ id: string; name: string }>;
        function UserPanel() {
          const [id, setId] = useState("");
          const [label, setLabel] = useState("");
          return async function load() {
            const next = await fetchUser();
            setId(next.id);
            setLabel("loaded");
          };
        }
        void UserPanel;
      `,
      {
        code: `
          import { useState } from "react";
          import type { User } from "./programs/correct/packages/domain/src/user";
          declare function fetchUsersPage(): Promise<{
            items: User[];
            nextCursor: string | null;
          }>;
          function UsersPage() {
            const [items, setItems] = useState<User[]>([]);
            const [nextCursor, setNextCursor] = useState<string | null>(null);
            return async function load() {
              const page = await fetchUsersPage();
              setItems(page.items);
              setNextCursor(page.nextCursor);
            };
          }
          void UsersPage;
        `,
        filename: "users-page.tsx",
      },
      {
        code: `
          import { useState } from "react";
          import type { User } from "./programs/correct/packages/domain/src/user";
          declare function fetchUserEnvelope(): Promise<{
            entity: User;
            fetchedAt: string;
          }>;
          function UserEnvelopePanel() {
            const [entity, setEntity] = useState<User | null>(null);
            const [fetchedAt, setFetchedAt] = useState("");
            return async function load() {
              const envelope = await fetchUserEnvelope();
              setEntity(envelope.entity);
              setFetchedAt(envelope.fetchedAt);
            };
          }
          void UserEnvelopePanel;
        `,
        filename: "user-envelope-panel.tsx",
      },
    ],
    invalid: [],
  },
);

ruleTester.run(
  "no-inline-structural-type-at-use-site",
  rule("no-inline-structural-type-at-use-site"),
  {
    valid: [
      fixture("programs/correct/named-structural-parameter-type.ts"),
      {
        filename: "shell.tsx",
        code: "import type { ReactNode } from 'react';\nexport function Shell({ children }: { children: ReactNode }) { return <div>{children}</div>; }",
      },
      {
        filename: "component-map.tsx",
        code: "import type { ReactNode } from 'react';\nexport const components = { Shell({ children }: { children: ReactNode }) { return <div>{children}</div>; } };",
      },
      "type Props = { onConfirm: (date: { year: number; month: number; day: number }) => void }; void ({} as Props);",
      "const formatDate = (date: { year: number; month: number; day: number }) => String(date.year); void formatDate;",
      "function local({ id }: { id: string }) { return id; } void local;",
    ],
    invalid: [
      {
        ...fixture("programs/drift/inline-structural-parameter-type.ts"),
        errors: 1,
      },
      {
        code: "export const createApi = () => ({ saveUser: async (req: { id: string; email: string }) => req.email });",
        errors: 1,
      },
      {
        code: "export function LoadUser(input: { id: string }) { return input.id; }",
        errors: 1,
      },
      {
        code: "export function loadUser({ id }: { id: string }) { return id; }",
        errors: 1,
      },
      {
        code: "export class Api { saveUser(req: { id: string; email: string }) { return req.email; } }",
        errors: 1,
      },
      {
        code: "const api = { saveUser: async (req: { id: string; email: string }) => req.email };\nexport { api };",
        errors: 1,
      },
      {
        filename: "loader.tsx",
        code: "export function loadUser(input: { id: string }) { const view = <div />; void view; return input.id; }",
        errors: 1,
      },
    ],
  },
);

ruleTester.run("no-raw-fetch-in-component", rule("no-raw-fetch-in-component"), {
  valid: [
    fixture("programs/correct/raw-fetch-in-helper.ts"),
    fixture("programs/drift/raw-fetch-in-component-module-helper.tsx"),
    {
      filename: "lowercase-utility.tsx",
      code: `
        async function loadUsers() {
          return fetch("/api/users");
        }

        export function UsersView() {
          return <div>Users</div>;
        }

        void loadUsers;
      `,
    },
    {
      filename: "pascalcase-non-component.ts",
      code: `
        async function UserLoader() {
          return fetch("/api/users");
        }

        void UserLoader;
      `,
    },
    {
      filename: "component-imported-fetch.tsx",
      code: `
        import { fetch } from "./api-client";

        export function UsersView() {
          fetch("/api/users");
          return <div>Users</div>;
        }
      `,
    },
    {
      filename: "component-local-fetch.tsx",
      code: `
        export function UsersView() {
          const fetch = (url: string) => apiClient(url);
          fetch("/api/users");
          return <div>Users</div>;
        }
      `,
    },
    {
      filename: "component-local-window.tsx",
      code: `
        export function UsersView() {
          const window = { fetch: (url: string) => apiClient(url) };
          window.fetch("/api/users");
          return <div>Users</div>;
        }
      `,
    },
    {
      filename: "component-local-self.tsx",
      code: `
        export function UsersView() {
          const self = { fetch: (url: string) => apiClient(url) };
          self.fetch("/api/users");
          return <div>Users</div>;
        }
      `,
    },
    {
      filename: "component-local-global-this.tsx",
      code: `
        export function UsersView() {
          const globalThis = { fetch: (url: string) => apiClient(url) };
          globalThis.fetch("/api/users");
          return <div>Users</div>;
        }
      `,
    },
  ],
  invalid: [
    { ...fixture("programs/drift/raw-fetch-in-component.tsx"), errors: 1 },
    {
      filename: "effect-fetch.tsx",
      code: `
        import { useEffect } from "react";

        export function ImpersonationWarning() {
          useEffect(() => {
            async function exchangeCode() {
              return fetch("/impersonation/exchange");
            }

            void exchangeCode();
          }, []);

          return <div>Impersonation</div>;
        }
      `,
      errors: 1,
    },
    {
      filename: "jsx-local-return-fetch.tsx",
      code: `
        export function UsersView() {
          const view = <div>Users</div>;
          fetch("/api/users");
          return view;
        }
      `,
      errors: 1,
    },
  ],
});

ruleTester.run("no-sql-string-concat", rule("no-sql-string-concat"), {
  valid: [
    fixture("programs/correct/static-parameterized-sql-template.ts"),
    "const msg = `generated from ${source}`;",
    fixture("programs/correct/parameterized-sql-query.ts"),
    {
      code: 'import { sql as drizzleSql } from "drizzle-orm/sql/sql";\ndeclare const id: string;\nconst rows = drizzleSql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm/sql/sql", export: "sql" }],
        },
      ],
    },
    {
      code: 'import { sql } from "drizzle-orm";\nconst rows = sql`SELECT ${sql.raw("CURRENT_TIMESTAMP")}`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
    },
  ],
  invalid: [
    { ...fixture("programs/drift/sql-template-interpolation.ts"), errors: 1 },
    { ...fixture("programs/drift/sql-string-concat.ts"), errors: 1 },
    {
      code: "function loadUser(id) { function sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } return sql`SELECT * FROM users WHERE id = ${id}`; }\nvoid loadUser;",
      errors: 1,
    },
    {
      code: "const db = { sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } };\nfunction loadUser(id) { return db.sql`SELECT * FROM users WHERE id = ${id}`; }\nvoid loadUser;",
      errors: 1,
    },
    {
      code: "declare const id: string;\nconst db = { sql(strings, ...values) { return String.raw({ raw: strings }, ...values); } };\nconst row = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
      options: [
        {
          safeTemplateTags: [
            {
              type: "DatabaseClient",
              member: "sql",
              source: "/database-client.ts",
            },
          ],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\nconst rows = sql`SELECT ${sql.raw(columnName)} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\ndeclare const useDynamic: boolean;\nconst rows = sql`SELECT ${useDynamic ? sql.raw(columnName) : sql.raw("id")} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
    {
      code: 'import { sql } from "drizzle-orm";\ndeclare const columnName: string;\ndeclare const fallback: string;\nconst rows = sql`SELECT ${fallback || sql.raw(columnName)} FROM users`;\nvoid rows;',
      options: [
        {
          safeTemplateTags: [{ module: "drizzle-orm", export: "sql" }],
        },
      ],
      errors: 1,
    },
  ],
});

typedRuleTester.run(
  "no-sql-string-concat safe template tag provenance",
  rule("no-sql-string-concat"),
  {
    valid: [
      {
        code: "declare const id: string;\nabstract class AbstractPostgresConnection { sql(strings: TemplateStringsArray, ...values: unknown[]) { return [strings, values]; } }\nclass DatabaseClient extends AbstractPostgresConnection {}\ndeclare const db: DatabaseClient;\nconst rows = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid rows;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "AbstractPostgresConnection",
                member: "sql",
                source: "/coupled-state.ts",
              },
            ],
          },
        ],
      },
      {
        code: "declare const id: string;\nclass Agent { sql(strings: TemplateStringsArray, ...values: unknown[]) { return [strings, values]; } }\nclass AIChatAgent extends Agent { load() { return this.sql`SELECT * FROM users WHERE id = ${id}`; } }\nvoid AIChatAgent;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              { type: "Agent", member: "sql", source: "/coupled-state.ts" },
            ],
          },
        ],
      },
    ],
    invalid: [
      {
        code: "declare const id: string;\nclass UntrustedDatabase { sql(strings: TemplateStringsArray, ...values: unknown[]) { return String.raw({ raw: strings }, ...values); } }\ndeclare const db: UntrustedDatabase;\nconst row = db.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
        options: [
          {
            safeTemplateTags: [
              {
                type: "DatabaseClient",
                member: "sql",
                source: "/database-client.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
      {
        code: "declare const id: string;\nclass Agent { sql(strings: TemplateStringsArray, ...values: unknown[]) { return String.raw({ raw: strings }, ...values); } }\ndeclare const agent: Agent;\nconst row = agent.sql`SELECT * FROM users WHERE id = ${id}`;\nvoid row;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "Agent",
                member: "sql",
                source: "/not-the-source.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
      {
        code: "declare const columnName: string;\ninterface SqlTag { (strings: TemplateStringsArray, ...values: unknown[]): unknown; raw(value: string): unknown; }\nclass AbstractPostgresConnection { sql: SqlTag = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => [strings, values], { raw: (value: string) => value }); }\ndeclare const db: AbstractPostgresConnection;\nconst rows = db.sql`SELECT ${db.sql.raw(columnName)} FROM users`;\nvoid rows;",
        filename: resolve(fixturesDir, "coupled-state.ts"),
        options: [
          {
            safeTemplateTags: [
              {
                type: "AbstractPostgresConnection",
                member: "sql",
                source: "/coupled-state.ts",
              },
            ],
          },
        ],
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run("no-unsafe-deserialize", rule("no-unsafe-deserialize"), {
  valid: [
    fixture("programs/correct/json-parse-string.ts"),
    fixture("programs/correct/schema-parse-unknown.ts"),
  ],
  invalid: [
    { ...fixture("programs/drift/json-parse-unknown.ts"), errors: 1 },
    { ...fixture("programs/drift/json-parse-any.ts"), errors: 1 },
  ],
});

const statusOptions = {
  statuses: {
    UserStatus: {
      owner: "packages/domain/src/user.ts",
      values: ["active", "disabled", "invited"],
    },
  },
};

ruleTester.run("no-status-literal-in-type", rule("no-status-literal-in-type"), {
  valid: [
    {
      ...fixture("programs/correct/packages/domain/src/user.ts"),
      options: [statusOptions],
    },
    {
      code: "const x = user.status === 'active';",
      filename: "/repo/apps/web/src/App.ts",
      options: [statusOptions],
    },
    {
      code: "type BadgeProps = { variant: 'active' | 'disabled' };",
      filename: "/repo/apps/web/src/Badge.ts",
      options: [statusOptions],
    },
    {
      code: "type FeatureStatus = 'active' | 'disabled';",
      filename: "/repo/apps/web/src/feature.ts",
      options: [statusOptions],
    },
    {
      code: "let status: 'active' | 'disabled'; void status;",
      filename: "/repo/apps/web/src/status.ts",
      options: [statusOptions],
    },
  ],
  invalid: [
    {
      ...fixture("programs/drift/status-literal-type-fork.ts"),
      options: [statusOptions],
      errors: 2,
    },
    {
      code: "type User = { status: 'active' | 'disabled' };",
      filename: "/repo/apps/web/src/user-copy.ts",
      options: [statusOptions],
      errors: 2,
    },
  ],
});

ruleTester.run(
  "no-nullable-positional-tuple",
  rule("no-nullable-positional-tuple"),
  {
    valid: [
      "type CoordinatePair = [number, number];",
      "type OpenRange = [Date | null, Date];",
    ],
    invalid: [
      {
        code: "type CustomRange = [Date | null, Date | null];",
        errors: 1,
      },
      {
        code: "type MaybeBounds = [start?: Date, end?: Date];",
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run(
  "no-nullable-positional-tuple type-aware aliases",
  rule("no-nullable-positional-tuple"),
  {
    valid: [
      "type MaybeDate = Date | null; type OpenRange = [MaybeDate, Date];",
    ],
    invalid: [
      {
        code: "type MaybeDate = Date | null; type CustomRange = [MaybeDate, MaybeDate];",
        errors: 1,
      },
      {
        code: `
          type Maybe<T> = T | null;
          type CustomRange = [Maybe<Date>, Maybe<Date>];
        `,
        errors: 1,
      },
    ],
  },
);

const authzRuleOptions = [{ authzFunctions: ["authorize"] }];

ruleTester.run("require-authz-check", rule("require-authz-check"), {
  valid: [
    {
      ...fixture("programs/correct/authz-before-params.ts"),
      options: authzRuleOptions,
    },
    {
      code: "function handler(req) { const body = req.body; return body; }",
      options: authzRuleOptions,
    },
    {
      code: "function outer(req) { authorize(req.user); }",
      options: authzRuleOptions,
    },
  ],
  invalid: [
    {
      ...fixture("programs/drift/params-without-authz.ts"),
      options: authzRuleOptions,
      errors: 1,
    },
    {
      ...fixture("programs/drift/nested-params-without-local-authz.ts"),
      options: authzRuleOptions,
      errors: 1,
    },
    {
      code: `
        function handler(req) {
          authorize(req.user);
          return req.params.projectId;
        }
      `,
      options: [{ authzFunctions: ["approvedAuthorize"] }],
      errors: 1,
    },
  ],
});

const acceptedPackageStructuralOptions = {
  packageTypeOwners: {
    firebaseAuthUserInfo: {
      package: "@firebase/auth",
      exportName: "UserInfo",
      reason: "Firebase Auth UserInfo is the accepted auth user info contract.",
    },
  },
};

const domainCanonicalOptions = {
  canonicalEntities: {
    Project: "programs/correct/packages/domain/src/project.ts",
  },
};

typedRuleTester.run(
  "no-structural-type-fork",
  rule("no-structural-type-fork"),
  {
    valid: [
      // Imports firebase types directly — no local redeclaration
      fixture("programs/correct/single-import.ts"),
      // Extends via intersection — adds fields, doesn't restate shape
      fixture("programs/correct/extends-intersection.ts"),
      // Discriminated union composition — firebase type as a variant
      fixture("programs/correct/union-composition.ts"),
      // Zod wraps the imported type via z.custom — no shape restatement
      fixture("programs/correct/zod-wraps-import.ts"),
      // Barrel re-export — not a redeclaration
      fixture("programs/correct/barrel-reexport.ts"),
      // Multi-file: canonical types file extends correctly
      fixture("programs/correct/multi-file/domain-types.ts"),
      // Multi-file: consumer imports from canonical types file
      fixture("programs/correct/multi-file/consumer.ts"),
      // Edge: below minimum field threshold — not enough overlap to flag
      fixture("programs/edge/below-threshold.ts"),
      // Edge: same field names but wrong types — structural mismatch, must not fire
      // (validates that the rule checks types, not just names)
      fixture("programs/edge/wrong-field-types.ts"),
      // Pure alias of an imported type — resolves to the package's own symbol, not a fork
      fixture("programs/correct/alias-of-import.ts"),
      // Generic container — property types reference the type parameter, matches nothing concrete
      fixture("programs/correct/generic-wrapper.ts"),
      fixture("programs/drift/redeclares-full.ts"),
      fixture("programs/drift/redeclares-named-differently.ts"),
      fixture("programs/drift/zod-schema-mirror.ts"),
      fixture("programs/drift/extends-and-redeclares.ts"),
      fixture("programs/drift/multi-file/drift-elsewhere.ts"),
      fixture("programs/edge/partial-subset.ts"),
      {
        ...fixture("programs/edge/partial-subset.ts"),
        options: [acceptedPackageStructuralOptions],
      },
      {
        code: `
          export type ReleaseSummary = {
            id: string;
            appId: string;
            version: string;
            status: "draft" | "submitted" | "released";
          };
        `,
        options: [generatedStructuralOptions],
      },
      fixture("programs/drift/redeclares-optional.ts"),
    ],
    invalid: [
      {
        ...fixture("programs/drift/generated-release-fork.ts"),
        options: [generatedStructuralOptions],
        errors: 1,
      },
      {
        ...fixture("programs/drift/redeclares-full.ts"),
        options: [acceptedPackageStructuralOptions],
        errors: 1,
      },
    ],
  },
);

typedRuleTester.run(
  "no-canonical-model-fork",
  rule("no-canonical-model-fork"),
  {
    valid: [
      {
        ...fixture("programs/correct/packages/domain/src/project.ts"),
        options: [domainCanonicalOptions],
      },
      {
        ...fixture("programs/correct/domain-project-form-draft.ts"),
        options: [domainCanonicalOptions],
      },
      {
        code: `
          export type ProjectListItem = {
            id: string;
            slug: string;
            name: string;
            ownerId: string;
          };
        `,
        options: [domainCanonicalOptions],
      },
    ],
    invalid: [
      {
        ...fixture("programs/drift/domain-project-fork.ts"),
        options: [domainCanonicalOptions],
        errors: 1,
      },
    ],
  },
);

async function lintWithStructuralFacts(file, ruleOptions = {}) {
  const facts = [];
  const drift = fixture(file);
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            projectService: {
              allowDefaultProject: ["*.ts"],
              defaultProject: resolve(fixturesDir, "tsconfig.json"),
            },
            tsconfigRootDir: fixturesDir,
          },
        },
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-structural-type-fork": ["error", ruleOptions],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(drift.code, {
    filePath: drift.filename,
  });
  return { facts, result };
}

it("emits structural proposal facts for unaccepted installed-package matches", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "structuralMatch",
        ruleId: "antidrift/no-structural-type-fork",
        adapterId: "typescript-eslint/type-owner",
        confidence: "deterministic-inventory",
        provenance: expect.arrayContaining(["AST", "TypeChecker"]),
        payload: expect.objectContaining({
          authorityState: "proposal",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: expect.stringContaining("#"),
          }),
          structuralMatch: expect.objectContaining({
            relation: "exact-owner-copy",
          }),
          diagnostic: expect.objectContaining({
            emitted: false,
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted generated owners with stable ids", async () => {
  const first = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );
  const second = await lintWithStructuralFacts(
    "programs/drift/generated-release-fork.ts",
    generatedStructuralOptions,
  );

  expect(first.result.messages).toHaveLength(1);
  expect(second.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "ReleaseRow" }),
          ownerType: expect.objectContaining({
            label: "fixtureGenerated#GeneratedRelease",
            authority: "generated-source",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

it("emits blocking structural facts from accepted package owners", async () => {
  const { facts, result } = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
    acceptedPackageStructuralOptions,
  );

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          authorityState: "accepted",
          localType: expect.objectContaining({ name: "UserInfo" }),
          ownerType: expect.objectContaining({
            label: "@firebase/auth#UserInfo",
            authority: "installed-package",
          }),
          diagnostic: expect.objectContaining({
            emitted: true,
            messageId: "structuralTypeFork",
          }),
        }),
      }),
    ]),
  );
});

async function lintCoupledStateProgramWithFacts(program, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
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
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-handrolled-resource-lifecycle-cells": [
            "error",
            options,
          ],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(program.code, {
    filePath: program.filename,
  });
  return { facts, result };
}

async function lintWithCoupledStateFacts(file, options = {}) {
  return lintCoupledStateProgramWithFacts(fixture(file), options);
}

async function lintCoupledStateCodeWithFacts(code, options = {}) {
  return lintCoupledStateProgramWithFacts(
    {
      code,
      filename: resolve(fixturesDir, "coupled-state.ts"),
    },
    options,
  );
}

async function lintSourceShardWithFacts(code, options = {}) {
  const facts = [];
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
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
        plugins: {
          antidrift: plugin,
        },
        rules: {
          "antidrift/no-shattered-ingested-entity-state": ["error", options],
        },
        settings: {
          antidrift: {
            semanticFacts: {
              repoRoot: fixturesDir,
              sink: {
                emit(fact) {
                  facts.push(fact);
                },
              },
            },
          },
        },
      },
    ],
  });

  const [result] = await eslint.lintText(code, {
    filePath: resolve(fixturesDir, "source-shard.tsx"),
  });
  return { facts, result };
}

it("emits a deterministic-enforcement lifecycle fact and diagnostic from one proof, with stable ids", async () => {
  const first = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const second = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );

  expect(first.result.messages).toHaveLength(1);
  expect(first.facts.map((fact) => fact.factId)).toEqual(
    second.facts.map((fact) => fact.factId),
  );
  expect(first.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
        adapterId: "react-state",
        confidence: "deterministic-enforcement",
        provenance: expect.arrayContaining([
          "AST",
          "control-flow",
          "scope-binding",
        ]),
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
        }),
      }),
    ]),
  );
});

it("keeps sibling payload setters inventory-only under an aggressive threshold", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ setterCount: 2 }),
      }),
    ]),
  );
});

it("proves lifecycle from derived catch writes and awaited source-member payloads", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function fetchRows(): Promise<{ rows: string[] }>;
    declare function codeFrom(error: unknown): string;

    function RowsPanel() {
      const [rows, setRows] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [errorCode, setErrorCode] = useState("");

      return async function load() {
        setPending(true);
        try {
          const response = await fetchRows();
          setRows(response.rows);
        } catch (err) {
          setErrorCode(codeFrom(err));
        } finally {
          setPending(false);
        }
      };
    }

    void RowsPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setErrorCode",
          payloadCell: "setRows",
        }),
      }),
    ]),
  );
});

it("ignores local useState impostors for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    function useState<T>(value: T): [T, (value: T) => void] {
      return [value, () => undefined];
    }
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("ignores imported useState when a local binding shadows it for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      function useState<T>(value: T): [T, (value: T) => void] {
        return [value, () => undefined];
      }
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      function useState<T>(value: T): [T, (value: T) => void] {
        return [value, () => undefined];
      }
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("ignores imported React objects when a local binding shadows them for React-state facts", async () => {
  const lifecycle = await lintCoupledStateCodeWithFacts(`
    import * as React from "react";
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const React = {
        useState<T>(value: T): [T, (value: T) => void] {
          return [value, () => undefined];
        },
      };
      const [users, setUsers] = React.useState<string[]>([]);
      const [pending, setPending] = React.useState(false);
      const [failure, setFailure] = React.useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);
  const sourceShard = await lintSourceShardWithFacts(`
    import React from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const React = {
        useState<T>(value: T): [T, (value: T) => void] {
          return [value, () => undefined];
        },
      };
      const [id, setId] = React.useState("");
      const [name, setName] = React.useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(lifecycle.result.messages).toHaveLength(0);
  expect(sourceShard.result.messages).toHaveLength(0);
  expect(lifecycle.facts).toHaveLength(0);
  expect(sourceShard.facts).toHaveLength(0);
});

it("downgrades a request-guarded lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-fetch.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("downgrades a lifecycle when the payload write is inside a positive abort-status guard", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          if (!controller.signal.aborted) {
            setUsers(result);
          }
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof when the abort check follows the payload setter", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          setUsers(result);
          if (controller.signal.aborted) return;
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof for abort calls without an abort status gate", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare function loadUsers(signal: AbortSignal): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        const controller = new AbortController();
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers(controller.signal);
          controller.abort();
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("does not downgrade lifecycle proof for unrelated abort-shaped members", async () => {
  const { facts, result } = await lintCoupledStateCodeWithFacts(`
    import { useState } from "react";
    declare const request: { aborted: boolean };
    declare const fake: { abort(): void; signal: { aborted: boolean } };
    declare function loadUsers(): Promise<string[]>;

    function UsersPanel() {
      const [users, setUsers] = useState<string[]>([]);
      const [pending, setPending] = useState(false);
      const [failure, setFailure] = useState<Error | null>(null);

      return async function load() {
        setPending(true);
        setFailure(null);
        try {
          const result = await loadUsers();
          if (request.aborted) return;
          fake.abort();
          if (fake.signal.aborted) return;
          setUsers(result);
        } catch (err) {
          setFailure(err);
        } finally {
          setPending(false);
        }
      };
    }

    void UsersPanel;
  `);

  expect(result.messages).toHaveLength(1);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "resourceLifecycleProof",
        confidence: "deterministic-enforcement",
        payload: expect.objectContaining({
          boolCell: "setPending",
          errorCell: "setFailure",
          payloadCell: "setUsers",
          requestGuard: false,
        }),
      }),
    ]),
  );
});

it("downgrades a useRef AbortController lifecycle to heuristic-inventory with no diagnostic", async () => {
  const { facts, result } = await lintWithCoupledStateFacts(
    "programs/correct/abort-guarded-component-scope.ts",
  );

  expect(result.messages).toHaveLength(0);
  expect(facts.map((fact) => fact.factKind)).not.toContain(
    "resourceLifecycleProof",
  );
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "broadSetterCoMutation",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({ requestGuard: true }),
      }),
    ]),
  );
});

it("emits a source-member shard candidate fact (inventory-only, no diagnostic)", async () => {
  const { facts, result } = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);

  expect(result.messages).toHaveLength(0);
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        factKind: "sourceMemberStateShardCandidate",
        ruleId: "antidrift/no-shattered-ingested-entity-state",
        adapterId: "react-state",
        confidence: "heuristic-inventory",
        payload: expect.objectContaining({
          source: "profile",
          editableCells: [],
          members: expect.arrayContaining([
            { setter: "setId", cell: "id", property: "id" },
            { setter: "setName", cell: "name", property: "displayName" },
          ]),
        }),
      }),
    ]),
  );
});

it("emits semantic facts that satisfy the registered public payload contract", async () => {
  const structural = await lintWithStructuralFacts(
    "programs/drift/redeclares-full.ts",
  );
  const lifecycle = await lintWithCoupledStateFacts(
    "programs/drift/handrolled-resource-lifecycle.ts",
  );
  const inventory = await lintWithCoupledStateFacts(
    "programs/correct/sibling-payload-setters.ts",
    { threshold: 2 },
  );
  const sourceShardCandidate = await lintSourceShardWithFacts(`
    import { useState } from "react";
    declare function fetchProfile(): Promise<{ id: string; displayName: string }>;
    function ProfileCard() {
      const [id, setId] = useState("");
      const [name, setName] = useState("");
      return async function load() {
        const profile = await fetchProfile();
        setId(profile.id);
        setName(profile.displayName);
      };
    }
    void ProfileCard;
  `);
  const facts = [
    ...structural.facts,
    ...lifecycle.facts,
    ...inventory.facts,
    ...sourceShardCandidate.facts,
  ];

  const pluginEmittedKinds = Object.entries(semanticFactKinds)
    .filter(([, contract]) => (contract.rules?.length ?? 0) > 0)
    .map(([kind]) => kind);
  expect(facts.map((fact) => fact.factKind)).toEqual(
    expect.arrayContaining(pluginEmittedKinds),
  );
  for (const fact of facts) {
    expectFactMatchesRegistry(fact);
  }
});

// ─── no-redundant-zod-parse fixture suite ─────────────────────────────────────
// Provenance-based: fires only when a value produced by `S.parse()` is re-parsed by the same S.
typedRuleTester.run("no-redundant-zod-parse", rule("no-redundant-zod-parse"), {
  valid: [
    // Boundary parse of raw/any input — the legitimate first validation
    fixture("programs/correct/zod-boundary-parse.ts"),
    // Different schema for the storage shape — a genuine second validation, not redundant
    fixture("programs/correct/zod-different-schema-reparse.ts"),
    // Double JSON.parse — not Zod, must stay silent (confirms the zod guard)
    fixture("programs/correct/zod-non-zod-parse.ts"),
    // Typed param re-parse — no local provenance, so Rule A correctly abstains (Rule C's case)
    fixture("programs/drift/zod-reparse-typed-value.ts"),
  ],
  invalid: [
    // Re-parse of a parsed value in the same function
    { ...fixture("programs/drift/zod-reparse-same-fn.ts"), errors: 1 },
    // Re-parse across functions in the same file via a module-scoped validated const
    {
      ...fixture("programs/drift/zod-reparse-cross-fn-same-file.ts"),
      errors: 1,
    },
    // Re-parse of a service/helper result already typed as the schema output
    { ...fixture("programs/drift/zod-reparse-service-result.ts"), errors: 1 },
  ],
});
