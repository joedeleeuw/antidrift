import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

import eslintPlugin from "./index.js";
import {
  fixture,
  plugin,
  rule,
  ruleTester,
  typedRuleTester,
} from "../../test/support/eslint-plugin-harness.mjs";

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
      // Action creators are PascalCase functions that return plain objects.
      'function EndTurnAction() { return { type: "end-turn" }; } dispatch(EndTurnAction());',
      // A minified bundle calls PascalCase bindings that return no JSX.
      "var Ab = function (e) { return e.a + 1; }; Ab(t);",
      // A generated client endpoint is a function, not a component.
      "const Endpoint0_0 = (raw) => ({ ...raw, kind: 'endpoint' }); Endpoint0_0(raw);",
      // Imported callees cannot be resolved to a JSX-returning body.
      'import { Card } from "./c"; Card();',
      "function Widget() { return null; } Widget({ label: 'x' });",
      "const Box = () => null; Box({ a: 1 });",
      // Solid, Qwik, Vue and compat-less Preact JSX is not React.
      {
        code: 'import { createSignal } from "solid-js"; const Fallback = () => <span />; const value = Fallback();',
        filename: "component.tsx",
      },
      {
        code: 'import { component$ } from "@builder.io/qwik"; const Box = () => <span />; Box();',
        filename: "component.tsx",
      },
      {
        code: 'import { h } from "preact"; const Box = () => <span />; Box();',
        filename: "component.tsx",
      },
      // A local helper spelled `memo` is not React's wrapper.
      "function memo(fn) { return fn; } const Format = memo(value => value.name); Format(record);",
    ],
    invalid: [
      {
        code: "function Widget() { return <div />; } Widget({ label: 'x' });",
        output: "function Widget() { return <div />; } <Widget label={'x'} />;",
      },
      {
        code: "const Box = () => <span />; Box({ a: 1 });",
        output: "const Box = () => <span />; <Box a={1} />;",
      },
      {
        code: "const List = function () { return <></>; }; List();",
        output: "const List = function () { return <></>; }; <List />;",
      },
      {
        code: 'import { forwardRef } from "react"; const Field = forwardRef((props, ref) => <input ref={ref} />); Field(props);',
        output:
          'import { forwardRef } from "react"; const Field = forwardRef((props, ref) => <input ref={ref} />); <Field {...props} />;',
      },
      {
        code: 'import React from "react"; const Row = React.memo(Item); Row({ id });',
        output:
          'import React from "react"; const Row = React.memo(Item); <Row id={id} />;',
      },
      {
        code: 'import { memo as cache } from "react"; const Widget = cache(() => <div />); Widget(props);',
        output:
          'import { memo as cache } from "react"; const Widget = cache(() => <div />); <Widget {...props} />;',
      },
      {
        code: "function Widget(ok) { if (ok) return <div />; throw new Error(); } Widget(props);",
        output:
          "function Widget(ok) { if (ok) return <div />; throw new Error(); } <Widget {...props} />;",
      },
      {
        code: "const Widget = () => <div />; const Alias = Widget; Alias(props);",
        output:
          "const Widget = () => <div />; const Alias = Widget; <Alias {...props} />;",
      },
      {
        code: 'import { h } from "preact"; import { memo } from "preact/compat"; const Box = () => <span />; Box();',
        output:
          'import { h } from "preact"; import { memo } from "preact/compat"; const Box = () => <span />; <Box />;',
      },
    ].map((testCase) => ({
      ...testCase,
      filename: "component.tsx",
      errors: 1,
    })),
  }
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
      {
        code: 'cn([ok ? "a b c d e" : "a b c d f"]);',
        filename: "new-thread.tsx",
        options: [{ ...duplicatedClassnameControls, helpers: ["cn"] }],
        errors: [{ messageId: "duplicatedConditionalClassnames" }],
      },
    ],
  }
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
      { filePath: "component.tsx" }
    )
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
          type E =
            | { kind: "a"; id: string; at: number }
            | { kind: "b"; id: string; at: number }
            | { kind: "c"; id: string; at: number }
            | { kind: "id"; id: string };
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
          type A = { kind: "a"; id: string; at: number };
          type B = { kind: "b"; id: string; at: number };
          type C = { kind: "c"; id: string; at: number };
          type D = { kind: "d"; id: string; label: string };
          type F = { kind: "f"; at: number; label: number };
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
  }
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
      { filePath: "types.ts" }
    )
  ).rejects.toThrow(/minRedundantDeclarations/u);
});

ruleTester.run(
  "no-mocked-response-body-oracle ESLint surface",
  eslintPlugin.rules["no-mocked-response-body-oracle"],
  {
    valid: [
      {
        code: `
          test("proves an independent request", async () => {
            backend.mockResolvedValue({ id: "user_1" });
            const response = await GET(request);
            await response.json();
            expect(backend).toHaveBeenCalledWith(request);
          });
        `,
        filename: "route.test.ts",
      },
    ],
    invalid: [
      {
        code: `
          test("echoes the mocked body", async () => {
            backend.mockResolvedValue({ id: "user_1" });
            const response = await GET(request);
            const body = await response.json();
            expect(body).toEqual({ id: "user_1" });
          });
        `,
        filename: "route.test.ts",
        errors: [{ messageId: "mockedResponseBodyOracle" }],
      },
    ],
  }
);

ruleTester.run(
  "no-nonindependent-test-oracle",
  rule("no-nonindependent-test-oracle"),
  {
    valid: [
      {
        ...fixture(
          "programs/correct/nonindependent-test-oracle-independent.ts"
        ),
        filename: "nonindependent-test-oracle-independent.test.ts",
      },
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
      {
        code: `
          it("normalizes row order", () => {
            const rows = normalize([{ id: 2 }, { id: 1 }]);
            expect(rows).toHaveLength(2);
            expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
          });
        `,
        filename: "rows.test.ts",
      },
    ],
    invalid: [
      {
        ...fixture("programs/drift/nonindependent-test-oracle-error-shape.ts"),
        filename: "nonindependent-test-oracle-error-shape.test.ts",
        errors: [
          { messageId: "errorShapeEcho" },
          { messageId: "errorShapeEcho" },
          { messageId: "errorShapeEcho" },
          { messageId: "errorShapeEcho" },
          { messageId: "errorShapeEcho" },
          { messageId: "errorShapeEcho" },
        ],
      },
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
        errors: [{ messageId: "outcomeEcho" }, { messageId: "errorShapeEcho" }],
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
          it("keeps rows in arranged order", () => {
            const rows = normalize([{ id: 1 }, { id: 2 }]);
            expect(rows).toHaveLength(2);
            expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
          });
        `,
        filename: "rows.test.ts",
        errors: [{ messageId: "lengthEcho" }, { messageId: "inputEcho" }],
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
  }
);

ruleTester.run("no-static-property-loop", rule("no-static-property-loop"), {
  valid: [
    {
      code: `
        it("checks table-driven behavior", () => {
          for (const { input, expected } of cases) {
            expect(parse(input)).toEqual(expected);
          }
        });
      `,
      filename: "parser.test.ts",
    },
    {
      code: `
        it("checks a runtime-derived invariant", () => {
          const permissions = permissionsFor(role);
          for (const action of requiredActions) {
            expect(permissions[action]).toBe(true);
          }
        });
      `,
      filename: "permissions.test.ts",
    },
  ],
  invalid: [
    {
      code: `
        function severity(ruleValue) {
          return Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
        }
        it("enables every custom TypeChecker rule", () => {
          const rules = collectRules(createConfig());
          for (const ruleId of [
            "antidrift/no-appeasement-cast",
            "antidrift/no-canonical-model-fork",
          ]) {
            expect(severity(rules[ruleId])).toBe("error");
          }
        });
      `,
      filename: "eslint-config/index.test.mjs",
      errors: [{ messageId: "staticPropertyEcho" }],
    },
  ],
});

ruleTester.run(
  "no-sentinel-absence-fallback",
  rule("no-sentinel-absence-fallback"),
  {
    valid: [
      // Display string that is not in the sentinel set
      'const title = doc.title ?? "Untitled";',
      // Numeric sentinel — deliberate false negative (needs property-name semantics)
      "const count = row.count ?? 0;",
      "const exit = Number(props.ExecMainStatus ?? 0);",
      // Non-literal fallback
      "const timeout = config.timeout ?? DEFAULT_TIMEOUT;",
      // Wrong operator — falsy coercion is a different doctrine
      'const name = user.name || "unknown";',
      // Plain identifier LHS — provenance of a local is not visible at the expression
      'const label = maybeName ?? "unknown";',
      // Call-expression LHS — out of v1 scope
      'const state = get(key) ?? "unknown";',
    ],
    invalid: [
      {
        code: 'const status = props.ExecMainStatus ?? "unknown";',
        errors: [{ messageId: "sentinelAbsenceFallback" }],
      },
      {
        code: 'const state = row?.state ?? "unavailable";',
        errors: [{ messageId: "sentinelAbsenceFallback" }],
      },
      {
        code: "const label = entry.status ?? `n/a`;",
        errors: [{ messageId: "sentinelAbsenceFallback" }],
      },
      {
        code: 'const active = unit.ActiveState ?? "N/A";',
        errors: [{ messageId: "sentinelAbsenceFallback" }],
      },
      {
        code: 'const missing = result.statuses[id]?.safeStatus ?? "missing";',
        errors: [{ messageId: "sentinelAbsenceFallback" }],
      },
    ],
  }
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
      "function formatDeviceName(device) { return device.name ?? ''; }",
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
      {
        code: "function deviceId() { return ''; }",
        errors: [
          {
            message:
              "Do not return an empty string from deviceId (source: ast-direct-empty). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
      {
        code: "const deviceId = () => '';",
        errors: [
          {
            message:
              "Do not return an empty string from deviceId (source: ast-direct-empty). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
      {
        code: "function readHostname() { try { return read(); } catch { return ''; } }",
        errors: [
          {
            message:
              "Do not return an empty string from readHostname (source: ast-catch-recovery). Throw or return an explicit nullable/result value so callers cannot confuse detection failure with a real value.",
          },
        ],
      },
    ],
  }
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
  }
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
  }
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
      // instanceof proves a class contract nominally
      "class ApiError extends Error { status = 500; }\nfunction isApiError(error: unknown): error is ApiError { return error instanceof ApiError; }",
      // Error satisfies an interface whose extra fields are all optional
      "interface ErrnoError extends Error { code?: string }\nfunction isErrnoError(error: unknown): error is ErrnoError { return error instanceof Error; }",
      // a literal discriminant on the asserted type is decisive
      "type ConflictError = { readonly _tag: 'ConflictError'; readonly message: string };\nconst isConflictError = (value: unknown): value is ConflictError => typeof value === 'object' && value !== null && '_tag' in value && value['_tag'] === 'ConflictError';",
      "type TabDrag = { kind: 'tab'; id: string };\nfunction isTabDrag(data: unknown): data is TabDrag { return typeof data === 'object' && data !== null && Reflect.get(data, 'kind') === 'tab'; }",
      "type Failure = { ok: false; reason: 'stale' | 'missing'; message: string };\nfunction isFailure(value: unknown): value is Failure { if (!value || typeof value !== 'object') return false; const reason = (value as Record<string, unknown>).reason; return reason === 'stale' || reason === 'missing'; }",
      "enum EntryType { Spans = 'spans', Css = 'css' }\ntype SpanEntry = { type: EntryType.Spans; data: string[] };\nconst isSpanEntry = (entry: any): entry is SpanEntry => entry.type === EntryType.Spans;",
      "type VideoEvent = { timestamp: number; data: { tag: 'video'; payload: string } };\nfunction isVideoEvent(event: any): event is VideoEvent { return event.data?.tag === 'video'; }",
      // a delegated type predicate checks the fields it asserts
      "type Artifact = { key: string; data: unknown };\ntype RootCause = { key: string; data: { cause: string } };\ndeclare function isArtifact(value: unknown): value is Artifact;\nfunction isRootCause(value: unknown): value is RootCause { return isArtifact(value) && typeof value.data === 'object'; }",
      "type Tagged = { readonly _tag: 'Timeout'; readonly ms: number };\ndeclare function isTagged<K extends string>(value: unknown, tag: K): value is { _tag: K };\nconst isTimeout = (error: unknown): error is Tagged => isTagged(error, 'Timeout');",
      "type ToolFile = { name: string; bytes: number };\ndeclare const matchesToolFile: (value: unknown) => value is ToolFile;\nconst isToolFile = (value: unknown): value is ToolFile => matchesToolFile(value);",
      // a typed record is not broad input
      "type Range = { start?: Date; end?: Date };\ntype Selection = { primary: Range };\nfunction isSelection(ranges: { [key: string]: Range }): ranges is Selection { return ranges.primary !== undefined; }",
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
      {
        code: "class Base { id = ''; }\ntype User = { id: string; email: string };\nfunction isUser(value: unknown): value is User { return value instanceof Base; }",
        errors: 1,
      },
      {
        code: "type FsError = { code: string; path: string };\nfunction isFsError(value: unknown): value is FsError { return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT'; }",
        errors: 1,
      },
      {
        code: "type Color = { kind: 'rgb'; r: number; g: number };\nfunction isColor(value: any): value is Color { return value.kind !== 'alias' && typeof value.r === 'number'; }",
        errors: 1,
      },
    ],
  }
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
      // Full lifecycle structure, but request-identity guarded by AbortController.
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
  }
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
      {
        filename: "panel.tsx",
        code: "export function Panel(props: { id: string; title: string }) { if (props.id) { return <div>{props.title}</div>; } return null; }",
      },
      {
        filename: "panel-local.tsx",
        code: "export function Panel(props: { id: string; title: string }) { switch (props.id) { case 'a': { const view = <div>{props.title}</div>; return view; } default: return null; } }",
      },
      "class Local { constructor(input: { id: string; title: string }) { void input; } } void Local;",
      "class Local { set value(input: { id: string; title: string }) { void input; } } void Local;",
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
      {
        filename: "loader-nested.tsx",
        code: "export function loadUser(input: { id: string }) { const render = () => { return <div />; }; void render; return input.id; }",
        errors: 1,
      },
      {
        code: "export const api = { save(req: { id: string; email: string }) { return req.email; } } satisfies Api;",
        errors: 1,
      },
      {
        code: "export const api = { save(req: { id: string; email: string }) { return req.email; } } as const;",
        errors: 1,
      },
      {
        code: "export const receive = ((input: { id: string; email: string }) => input.email) satisfies Handler;",
        errors: 1,
      },
      {
        code: "export class Api { constructor(input: { id: string; title: string }) { void input; } }",
        errors: 1,
      },
      {
        code: "class Api { set value(input: { id: string; title: string }) { void input; } }\nexport { Api };",
        errors: 1,
      },
    ],
  }
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
  }
);
