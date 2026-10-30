export const portableCases = [
  {
    name: "no-dated-comments",
    invalid: "// Verified against the live API on 2026-06-10.\nstart();",
    valid:
      "/**\n * @example\n * formatDay(new Date('2026-06-10'))\n */\nstart();",
  },
  {
    name: "no-bun-api-in-shared",
    filename: "packages/shared/portability.ts",
    invalid: 'import { file } from "bun";',
    valid: 'import { read } from "./runtime-adapter";',
  },
  {
    name: "no-vague-names",
    artifact: "eslint-plugin/rules/no-vague-names.js",
    invalid: "function loadUserUser() {}",
    valid: "function loadUser() {}",
  },
  {
    name: "no-as-never",
    invalid: "prepareStep({ steps: [toolStep] as never });",
    valid: "prepareStep({ steps: [toolStep] });",
  },
  {
    name: "no-todo-without-issue",
    occurrences: 2,
    invalid:
      "// TODO clean up AI generated workaround\n// TODO(verify): confirm remote audio track rendering\nstart();",
    valid:
      "// TODO(APP-42): confirm remote audio track rendering\n// The generator owns this mapping.\nstart();",
  },
  {
    name: "no-default-export-in-domain",
    filename: "domain/entity.ts",
    invalid: "export default class Entity {}",
    valid: "export class Entity {}",
  },
  {
    name: "no-anemic-errors",
    occurrences: 2,
    invalid:
      'function fail() { throw new Error("Something went wrong"); }\nasync function load() { try { return await read(); } catch { return []; } }',
    valid:
      "function fail() { throw new RequestError({ status, cause }); }\nasync function load() { try { return await read(); } catch (error) { throw new LoadError({ cause: error }); } }",
  },
  {
    name: "no-relative-cross-package-imports",
    filename: "apps/client/src/main.ts",
    invalid: 'import { secret } from "../../other/src/internal";',
    valid: 'import { shared } from "@homer/shared";',
  },
  {
    name: "no-tutorial-comments",
    occurrences: 3,
    invalid:
      "// This function returns the value\n// ====================\n// --- Helpers ---\nfunction value() { return 1; }",
    valid:
      "// The wire protocol uses big endian order.\n// |---|---|\n// https://example.com/a---b\nconst gap = 3 - 1; // a --- b\nfunction value() { return gap; }",
  },
  {
    name: "no-reexport-only-module",
    filename: "parsers.ts",
    occurrences: 1,
    invalid:
      'import { parse } from "./owner";\nexport { parse };\nexport * from "./owner";',
    valid: 'export { parse } from "./_internal";',
  },
  {
    name: "no-handrolled-resource-lifecycle-cells",
    filename: "Field.tsx",
    invalid:
      'import { useState, useEffect } from "react";\nexport function Field({ value }) {\n  const [draft, setDraft] = useState(value);\n  useEffect(() => { setDraft(value); }, [value]);\n  return <input value={draft} />;\n}',
    valid:
      'import { useState, useEffect } from "react";\nexport function Field({ value }) {\n  const [draft, setDraft] = useState(value);\n  useEffect(() => { setDraft(value); }, [value]);\n  return <input value={draft} onChange={(event) => setDraft(event.target.value)} />;\n}',
  },
  {
    name: "no-debug-residue-filenames",
    filename: "value_temp.ts",
    invalid: "export const value = 1;",
    valid: "export const value = 1;",
    validFilename: "value.ts",
  },
  {
    name: "no-placeholder-tests",
    filename: "behavior.test.ts",
    invalid: 'test("saves", () => {});',
    valid: 'test("saves", () => { expect(save()).toBe(true); });',
  },
  {
    name: "confine-owner",
    options: {
      entries: [
        {
          id: "storage",
          owner: ["src/storage.ts"],
          enforcement: {
            kind: "import",
            specifiers: ["storage-sdk"],
          },
        },
      ],
    },
    invalid: 'import { client } from "storage-sdk";',
    valid: 'import { store } from "./storage";',
  },
  {
    name: "docs-source-policy",
    options: {
      dependencies: ["react"],
      sources: {},
      policyFile: "docs-sources.mjs",
    },
    invalid: "export const documentation = {};",
    valid: "export const documentation = {};",
    validOptions: {
      dependencies: ["react"],
      sources: {
        react: {
          url: "https://react.dev/llms.txt",
          dependencies: ["react"],
        },
      },
    },
    filename: "docs-sources.mjs",
  },
  {
    name: "icon-button-requires-tooltip",
    invalid: '<Button size="icon"><PlusIcon /></Button>;',
    valid:
      '<Tooltip><TooltipTrigger><Button size="icon"><PlusIcon /></Button></TooltipTrigger><TooltipContent>Add</TooltipContent></Tooltip>;',
  },
  {
    name: "no-adhoc-loader",
    invalid: '<div className="animate-spin" />;',
    valid: "<Loader />;",
  },
  {
    name: "no-ambient-hotkey-format",
    invalid: 'import { detectPlatform } from "@tanstack/hotkeys";',
    valid: 'import { formatHotkeyForPlatform } from "./hotkeys";',
  },
  {
    name: "no-async-context-enter-with",
    invalid:
      'import { AsyncLocalStorage } from "node:async_hooks"; const storage = new AsyncLocalStorage(); storage.enterWith(value);',
    valid:
      'import { AsyncLocalStorage } from "node:async_hooks"; const storage = new AsyncLocalStorage(); storage.run(value, execute);',
  },
  {
    name: "no-auth-token-in-web-storage",
    invalid: 'localStorage.setItem("access_token", token);',
    valid: 'localStorage.setItem("theme", "dark");',
  },
  {
    name: "no-awaited-builder-union",
    invalid:
      "async function build() { return await (condition ? query.limit(1) : query); }",
    valid: "async function build() { return await factory(); }",
  },
  {
    name: "no-centered-scroll-column",
    invalid: '<div className="mx-auto max-w-lg overflow-y-auto" />;',
    valid:
      '<div className="overflow-y-auto"><main className="mx-auto max-w-lg" /></div>;',
  },
  {
    name: "no-dialog-trigger-menu-item",
    invalid:
      "<DialogTrigger><DropdownMenuItem>Open</DropdownMenuItem></DialogTrigger>;",
    valid: "<DropdownMenuItem onSelect={openDialog}>Open</DropdownMenuItem>;",
  },
  {
    name: "no-disabled-tooltip-trigger",
    invalid:
      "<TooltipTrigger render={<Button disabled />}>Save</TooltipTrigger>;",
    valid:
      "<TooltipTrigger><span><button disabled>Save</button></span></TooltipTrigger>;",
  },
  {
    name: "no-eager-singleton",
    invalid: "const storage = new S3Client({});",
    valid: "function storage() { return new S3Client({}); }",
  },
  {
    name: "no-inline-style-colors",
    invalid:
      '<View style={{ flex: 1, backgroundColor: "rgb(255 255 255)" }} />;',
    valid: "<View style={{ flex: 1, backgroundColor: colors.surface }} />;",
  },
  {
    name: "no-omitted-prop-respread",
    invalid:
      'type Props = Omit<ButtonProps, "disabled">; function Action(props: Props) { return <Button {...props} />; }',
    valid:
      'type Props = Omit<ButtonProps, "disabled">; function Action(props: Props) { return <Button {...props} disabled={false} />; }',
  },
  {
    name: "no-partial-record-satisfies",
    invalid:
      'const labels = { ready: "Ready" } satisfies Partial<Record<State, string>>;',
    valid: 'const labels: Partial<Record<State, string>> = { ready: "Ready" };',
  },
  {
    name: "no-path-prefix-containment",
    invalid:
      'import { resolve } from "node:path"; const target = resolve(root, name); if (target.startsWith(root)) read(target);',
    valid:
      'import { relative, isAbsolute } from "node:path"; const child = relative(root, target); if (!child.startsWith("..") && !isAbsolute(child)) read(target);',
  },
  {
    name: "no-physical-properties",
    invalid: '<View className="ml-2 border-l pl-1" />;',
    valid: '<View className="ms-2 border-s ps-1" />;',
  },
  {
    name: "no-raw-foreground-opacity",
    invalid: '<p className="text-foreground/50" />;',
    valid: '<p className="text-muted-foreground" />;',
  },
  {
    name: "no-redacted-log-attribute-key",
    invalid: 'logger.info("saved", { queueName: value });',
    valid: 'logger.info("saved", { recordId: value });',
  },
  {
    name: "no-spread-input-in-query-key",
    invalid: 'const options = { queryKey: ["search", { ...input }] };',
    valid: 'const queryKey = ["search", input.term];',
  },
  {
    name: "no-static-devtools-import",
    invalid:
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";',
    valid: 'const devtools = () => import("@tanstack/react-query-devtools");',
  },
  {
    name: "no-unformatted-number",
    invalid: "<Text>{attachments.length} selected</Text>;",
    valid: "<Text>{formatter.number(attachments.length)} selected</Text>;",
  },
  {
    name: "no-unsafe-inner-html",
    invalid: "<div dangerouslySetInnerHTML={{ __html: content }} />;",
    valid: "<div>{content}</div>;",
  },
  {
    name: "no-portal-under-interactive-ancestor",
    invalid: "<button><DialogContent>Content</DialogContent></button>;",
    valid: "<><button>Open</button><DialogContent>Content</DialogContent></>;",
  },
  {
    name: "require-detached-label-shape",
    invalid: 'detached(save(), "save");',
    valid: 'detached(save(), "storage.save");',
  },
  {
    name: "require-dir-on-rendered-name",
    invalid: "<Text>{project.displayName}</Text>;",
    valid: "<BidiText>{project.displayName}</BidiText>;",
  },
  {
    name: "require-exhaustive-panic",
    invalid:
      "function select(value) { const exhaustive: never = value; return exhaustive; }",
    valid:
      "function select(value) { const exhaustive: never = value; throw new Error(`Unsupported: ${exhaustive}`); }",
  },
  {
    name: "require-fetch-timeout",
    invalid:
      'const upstream = await fetch(upstreamUrl, { method: "GET", cache: "no-store" });',
    valid: "const upstream = await fetch(upstreamUrl, { signal });",
  },
  {
    name: "require-function-replacer",
    invalid: "next = current.replace(edit.oldString, edit.newString);",
    valid: "next = current.replace(edit.oldString, () => edit.newString);",
  },
  {
    name: "require-query-key-factory",
    invalid:
      'queryClient.invalidateQueries({ queryKey: ["agent-config", baseURL] });',
    valid:
      "queryClient.invalidateQueries({ queryKey: queryKeys.agentConfig(baseURL) });",
  },
  {
    name: "require-query-signal",
    invalid:
      'const options = { queryKey: ["users"], queryFn: async () => fetch(url) };',
    valid:
      'const options = { queryKey: ["users"], queryFn: async ({ signal }) => fetch(url, { signal }) };',
  },
  {
    name: "require-safe-window-open",
    invalid:
      'window.open(conversationUrl(projectId, row.conversationId), "_blank");',
    valid:
      "openIsolatedWindow(conversationUrl(projectId, row.conversationId));",
  },
  {
    name: "require-stable-snapshot",
    invalid:
      'import { useSyncExternalStore } from "react"; useSyncExternalStore(subscribe, () => ({ value: store.value }));',
    valid:
      'import { useSyncExternalStore, useState, useMemo } from "react"; useSyncExternalStore(subscribe, () => store.snapshot); function MyComponent() { const [ctx] = useState(() => createContext()); const client = useMemo(() => new QueryClient(), []); const dateStr = new Date().toLocaleString(); return null; }',
  },
  {
    name: "require-stream-reader-disposal",
    invalid:
      "async function chunks(stream: ReadableStream) { const reader = stream.getReader(); const result = await reader.read(); return result; }",
    valid:
      "async function chunks(stream: ReadableStream) { const reader = stream.getReader(); try { return await reader.read(); } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } } }",
  },
  {
    name: "no-raw-filename-write",
    invalid: "const row = { fileName: part.filename };",
    valid: "const row = { fileName: sanitizeFilename(part.filename) };",
  },
  {
    name: "no-unsanitized-href",
    invalid: "<a href={input.url}>Open</a>;",
    valid:
      'import { sanitizeHref as safe } from "./url-policy"; <a href={safe(external)} />;',
    options: {
      sanitizers: [
        {
          module: "./url-policy",
          export: "sanitizeHref",
        },
      ],
    },
  },
  {
    name: "require-secure-document-response",
    invalid:
      'new Response(body, { headers: { "Content-Disposition": "attachment; filename=file.txt" } });',
    valid: "secureDocumentResponse(body);",
  },
  {
    name: "no-unlisted-external-imports",
    filename: "apps/client/src/imports.ts",
    invalid: 'import { thing } from "undeclared-package";',
    valid: 'import { thing } from "@homer/shared/machine";',
  },
  {
    name: "no-host-path-literal",
    invalid: 'const root = "/Users/alice/code/app";',
    valid: 'const root = "/var/tmp/app";',
  },
  {
    name: "no-hookless-use-function",
    invalid:
      "export function useDocumentTitle(title: string) { document.title = title; }",
    valid:
      'import { useEffect } from "react"; export function useDocumentTitle(title: string) { useEffect(() => { document.title = title; }, [title]); } export const useArrowHook = () => { useEffect(() => {}, []); };',
  },
  {
    name: "no-unstable-render-default-collection",
    invalid:
      'import { useState } from "react"; export function useModelDirectory(usable) { const [s] = useState(); return buildModelDirectory(usable?.service ?? []); }',
    valid:
      'import { useState } from "react"; const EMPTY = []; export function useModelDirectory(usable) { const [s] = useState(); function handleClick() { const x = usable?.service ?? []; } return <button onClick={() => { const y = usable?.service ?? []; }} />; }',
  },
];

const sharedHelperSources = {
  "tooling/antidrift/src/__probe_helpers.ts": `
      declare const Context: {
        Tag: (id: string) => <Self, Shape>() => { new (): Self; of: (s: Shape) => Shape; pipe: (...fns: unknown[]) => unknown };
      };
      declare const Layer: { succeed: <T, S>(tag: T, s: S) => unknown };
      export interface UsersRepoShape { findById(id: string): string; count(): number }
      export class UsersRepo extends Context.Tag("UsersRepo")<UsersRepo, UsersRepoShape>() {}
      export const parseUserId = (raw: string): string => raw.trim();
      export const makeUsersRepo = (): UsersRepoShape => ({ findById: (id) => parseUserId(id), count: () => 1 });
      export const requireUsersScope = (): UsersRepoShape => { void UsersRepo.pipe(); return { findById: (id) => id, count: () => 0 }; };
      export const refineUsersScope = (scope: UsersRepoShape): UsersRepoShape => scope;
      export const UsersRepoLive = Layer.succeed(UsersRepo, makeUsersRepo());
      export function relativeAge(updatedAt: number, now = Date.now()): number { return now - updatedAt; }
      export function formatNow(): number { return Date.now(); }
    `,
  "tooling/antidrift/src/__probe_seam_fakes.mock.ts": `
      import type { Ticker } from "./__probe_seam_multi.js";
      import { runGit, Stamp } from "./__probe_seam_runner.js";
      export const fakeTicker: Ticker = { tick: () => 1 };
      runGit(["log"], () => Buffer.from(""));
      new Stamp(() => 1).at();
    `,
  "tooling/antidrift/src/__probe_use_platform.native.ts": `
      import { useState } from "react";
      export function useNativeBiometrics() {
        const [supported] = useState(true);
        return { supported };
      }
    `,
  "tooling/antidrift/src/node_modules/convex/server.ts": `
      export function query<Args, Returns>(config: { args?: Args; returns?: Returns; handler: (...a: never[]) => unknown }): typeof config {
        return config;
      }
    `,
  "tooling/antidrift/src/node_modules/convex/values.ts": `
      export const v = {
        string: () => "string" as const,
        null: () => null,
        any: () => "any" as const,
        object: <T>(fields: T): T => fields,
      };
    `,
  "tooling/antidrift/src/node_modules/@valibot/to-json-schema/index.ts": `
      export function toJsonSchema<T>(schema: T): T {
        return schema;
      }
    `,
  "tooling/antidrift/src/node_modules/valibot/index.ts": `
      export const v = {
        string: () => ({ kind: "string" as const }),
        pipe: <S, R>(schema: S, action: (input: S) => R): R => action(schema),
        transform: <I, O>(fn: (input: I) => O) => (schema: I): O => fn(schema),
      };
    `,
  "tooling/antidrift/src/node_modules/swr/index.ts": `
      export function useSWR<Data>(key: string, fetcher: (key: string) => Promise<Data>): Data {
        void key;
        void fetcher;
        return undefined as never;
      }
    `,
};

export function buildSharedHelperFiles(repoRoot, resolve) {
  return Object.fromEntries(
    Object.entries(sharedHelperSources).map(([file, text]) => [
      resolve(repoRoot, file),
      text,
    ])
  );
}

export const coreHeadlessProbes = [
  {
    name: "no-anemic-errors (decode collapsed to nullable via ??, success ternary, and nullish catch, including raw/text inputs and a JSON.parse behind a tagged schema; sniffer, line-chunk, loop, error-using, enum, scalar, discriminated-union, and required-literal classifier sites stay clean; an optional literal is not a tag)",
    rule: "antidrift/no-anemic-errors",
    source: `
      declare const schema: { safeParse(x: unknown): { success: boolean; data?: Row }; parse(x: unknown): Row };
      interface Row { id: string }
      export function viaNullish(input: unknown) { return schema.safeParse(input).data ?? null; }
      export function viaConditional(input: unknown) { const r = schema.safeParse(input); return r.success ? r.data : undefined; }
      export function viaCatch(body: string) { try { return JSON.parse(body) as Row; } catch { return null; } }
      export function viaSchemaCatch(input: unknown) { try { return schema.parse(input); } catch { return undefined; } }
      export function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
      export function fromRaw(raw: string) { return schema.safeParse(JSON.parse(raw)).data ?? null; }
      export function tryParseRow(input: unknown) { return schema.safeParse(input).data ?? null; }
      export function perLine(lines: string[]) { for (const entry of lines) { const v = schema.safeParse(entry).data ?? null; void v; } }
      export function chunkParam(line: string) { return schema.safeParse(line).data ?? null; }
      export function proper(input: unknown) { const r = schema.safeParse(input); if (!r.success) throw new RowDecodeError(r); return r.data; }
      export function caughtUsed(body: string) { try { return JSON.parse(body) as Row; } catch (error) { console.error(error); return null; } }
      class RowDecodeError extends Error { constructor(readonly result: unknown) { super("row decode rejected"); } }
      declare const z: { string(): Decoder; enum(values: string[]): Decoder; literal(value: string): Decoder; object(shape: Record<string, Decoder>): Decoder; discriminatedUnion(key: string, members: Decoder[]): Decoder };
      interface Decoder { safeParse(x: unknown): { success: boolean; data?: Row }; parse(x: unknown): Row; optional(): Decoder }
      const LevelSchema = z.enum(["info", "warn"]);
      const EventSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("a") })]);
      const TaggedSchema = z.object({ type: z.literal("response"), id: z.string() });
      const OptionalTagSchema = z.object({ heartbeat: z.literal("x").optional(), id: z.string() });
      export function level(input: unknown) { const r = LevelSchema.safeParse(input); return r.success ? r.data : undefined; }
      export function field(input: Record<string, unknown>) { return z.string().safeParse(input.name).data ?? undefined; }
      export function eventOf(input: unknown) { return EventSchema.safeParse(input).data ?? null; }
      export function tagged(input: unknown) { try { return TaggedSchema.parse(input); } catch { return null; } }
      export function optionalTag(input: unknown) { return OptionalTagSchema.safeParse(input).data ?? null; }
      export function taggedText(body: string) { try { return TaggedSchema.parse(JSON.parse(body)); } catch { return null; } }
    `,
    expectedCount: 8,
  },
  {
    name: "no-contract-appeasement-projection (complementary ok/error return bags reported once per function; proper discriminated union stays clean)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      export function bag(input: string) {
        if (input.length > 0) { return { ok: true, value: input, error: null }; }
        return { ok: false, value: null, error: "empty" };
      }
      export function union(input: string) {
        if (input.length > 0) { return { ok: true, value: input }; }
        return { ok: false, error: "empty" };
      }
      export const ternary = (input: string) => input ? { success: true, error: undefined } : { success: false, error: new Error("empty input") };
    `,
    expectedCount: 2,
  },
  {
    name: "unknown-input-must-be-decoded (call argument & assignment sinks)",
    rule: "antidrift/unknown-input-must-be-decoded",
    source: `
      type Account = { id: string };
      declare function consume(account: Account): void;
      export async function load(response: Response) {
        consume(await response.json());
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-unsafe-deserialize (alias-to-contract and JSON.stringify roundtrip)",
    rule: "antidrift/no-unsafe-deserialize",
    source: `
      type Account = { id: string };
      export function parseAccount(text: string) {
        const raw = JSON.parse(text);
        const account: Account = raw;
        const cloned = JSON.parse(JSON.stringify(account));
        return String(account.id) + String(cloned);
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-identity-schema-transform (direct identity, union transform, and full-object call repack)",
    rule: "antidrift/no-identity-schema-transform",
    source: `
      import { z } from "zod";
      const PartSchema = z.union([z.object({ id: z.string(), kind: z.literal("a") }), z.object({ id: z.string(), kind: z.literal("b") })]);
      declare function mapPart(input: { id: string; kind: "a" | "b" }): string;
      export const schema = z.string().transform((value) => value);
      export const unionEnvelope = PartSchema.transform((part) => ({ id: part.id, kind: part.kind }));
      export const mappedEnvelope = unionEnvelope.transform((part) => mapPart({ id: part.id, kind: part.kind }));
    `,
    expectedCount: 3,
  },
  {
    name: "no-redundant-zod-parse (z.infer<typeof schema>)",
    rule: "antidrift/no-redundant-zod-parse",
    source: `
      import { z } from "zod";
      const schema = z.object({ id: z.string() });
      export function handle(input: z.infer<typeof schema>) {
        return schema.parse(input);
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-wrapping-functions (a leading generator header marks the file generated and silences the hop)",
    rule: "antidrift/no-wrapping-functions",
    source: `// Code generated by probe-codegen. DO NOT EDIT.
      function loadName(id: string): string {
        return id.trim();
      }
      function readName(id: string): string {
        return loadName(id);
      }
      export function render(id: string): string {
        return readName(id);
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-wrapping-functions (generator words inside code, a string or a trailing comment, do not mark the file generated)",
    rule: "antidrift/no-wrapping-functions",
    source: `
      const notice = "auto-generated by the build; do not edit";
      function loadName(id: string): string {
        return id.trim();
      }
      function readName(id: string): string {
        return loadName(id);
      }
      export function render(id: string): string {
        return readName(id) + notice;
      }
      // @generated markers below the first statement are not headers
    `,
    expectedCount: 2,
  },
  {
    name: "no-wrapping-functions (widened return type string | null must stay clean)",
    rule: "antidrift/no-wrapping-functions",
    source: `
      function readId(item: { id: string }): string {
        return item.id;
      }
      export function readNullableId(item: { id: string }): string | null {
        return readId(item);
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-appeasement-cast (unresolved import target)",
    rule: "antidrift/no-appeasement-cast",
    source: `
      import type { Account } from "./nonexistent-module-for-probe.js";
      export function castIt(input: unknown) {
        return input as Account;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "inline eslint-disable-next-line suppresses native antidrift rule",
    rule: "antidrift/no-compat-names",
    source: `
      // eslint-disable-next-line antidrift/no-compat-names -- probe
      export const legacyAdapter = 1;
    `,
    expectedCount: 0,
  },
  {
    name: "eslint-disable inside string literal does not suppress native antidrift rule",
    rule: "antidrift/no-compat-names",
    source: `
      export const fakeDirective = "/* eslint-disable antidrift/no-compat-names */";
      export const legacyAdapter = 1;
    `,
    expectedCount: 1,
  },
  {
    name: "no-vague-names (duplicate context stem)",
    rule: "antidrift/no-vague-names",
    source: "export function loadUserUser() {}\n",
    expectedCount: 1,
  },
  {
    name: "no-vague-names (import alias, type suffix, and rename report while shorthand destructuring and value-role compounds stay clean)",
    rule: "antidrift/no-vague-names",
    source: `
      import { type PlanViewRow as PlanViewRowType, User as UserIcon } from "./nonexistent-module-for-probe.js";
      export type AccountData = { id: string; row?: PlanViewRowType; icon?: typeof UserIcon };
      export function animate({ data, toValue, initialValue }: { data: number; toValue: number; initialValue: number }) {
        const defaultValue = toValue + initialValue + data;
        const { prop: item } = { prop: defaultValue };
        return item;
      }
    `,
    expectedCount: 3,
  },
  {
    name: "no-unformatted-number (checker-typed number outside NUMERIC_WORDS)",
    rule: "antidrift/no-unformatted-number",
    file: "tooling/antidrift/src/__probe_unformatted_num.tsx",
    source: `
      export function UnreadBadge({ unread }: { unread: number }) {
        return <span>{unread}</span>;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-contract-appeasement-projection (bagReshaper query envelope with callback & relational condition)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      type QueryResult = {
        status: "pending" | "error" | "success";
        data: string[] | undefined;
        error: { message: string } | null;
        refetch: () => Promise<void>;
      };
      export function serviceModelListState(query: QueryResult) {
        if (query.status === "pending") {
          return { kind: "loading" as const };
        }
        if (query.status === "error") {
          return {
            kind: "error" as const,
            message: query.error?.message ?? "Failed",
            retry: () => void query.refetch(),
          };
        }
        if ((query.data?.length ?? 0) > 0) {
          return { kind: "ready" as const, models: query.data };
        }
        return { kind: "empty" as const };
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-contract-appeasement-projection (bagReshaper whole-root spread exemption)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      type Bag = { ok: boolean; value: string };
      export function wrapSpread(bag: Bag) {
        return bag.ok ? { kind: "ok" as const, ...bag } : { kind: "err" as const, ...bag };
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-contract-appeasement-projection (bagReshaper whole-root shorthand exemption)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      type Bag = { ok: boolean; value: string };
      export function wrapShorthand(bag: Bag) {
        return bag.ok ? { kind: "ok" as const, bag } : { kind: "err" as const, bag };
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-contract-appeasement-projection (bagReshaper satisfies table row contract exemption)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      type RawEvent = { id: string; text: string };
      type TaggedEvent =
        | { kind: "message"; id: string; text: string }
        | { kind: "error"; code: number };
      type Decoders = { message: (raw: RawEvent) => TaggedEvent };
      export const DECODERS = {
        message: (raw) => ({ kind: "message", id: raw.id, text: raw.text }),
      } satisfies Decoders;
    `,
    expectedCount: 0,
  },
  {
    name: "no-contract-appeasement-projection (bagReshaper satisfies table row single contract reported)",
    rule: "antidrift/no-contract-appeasement-projection",
    source: `
      type RawEvent = { id: string; text: string };
      type TaggedEvent = { kind: "message"; id: string; text: string };
      type Decoders = { message: (raw: RawEvent) => TaggedEvent };
      export const DECODERS = {
        message: (raw) => ({ kind: "message", id: raw.id, text: raw.text }),
      } satisfies Decoders;
    `,
    expectedCount: 1,
  },
  {
    name: "no-appeasement-cast (unnarrowed string cast to closed literal union reported)",
    rule: "antidrift/no-appeasement-cast",
    source: `
      export function parseRole(raw: string) {
        return raw as "admin" | "member";
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-appeasement-cast (direct JSON.parse cast deferred to unknown-input-must-be-decoded)",
    rule: "antidrift/no-appeasement-cast",
    source: `
      export function parsePayload(raw: string) {
        return JSON.parse(raw) as { id: string };
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-sql-string-concat (external SQL tag provenance stays clean while .unsafe() and local lookalikes report)",
    rule: "antidrift/no-sql-string-concat",
    source: `
      import * as SqlClient from "effect/sql/SqlClient";
      export function* describeAction(name: string) {
        const sql = yield* SqlClient.SqlClient;
        yield* sql\`SELECT id FROM users WHERE id = \${name}\`;
        yield* sql\`SELECT id FROM users WHERE \${sql.unsafe(name)}\`;
        const localSql = (s: TemplateStringsArray, ...v: unknown[]) => "";
        localSql\`SELECT id FROM users WHERE id = \${name}\`;
        return "Please update your profile before you set " + name;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "require-query-key-factory (QueryClient getQueryData, prefetchQuery, and SWR mutate reported)",
    rule: "antidrift/require-query-key-factory",
    source: `
      import { mutate } from "swr";
      export function refreshUser(queryClient: { getQueryData: (k: unknown) => unknown; prefetchQuery: (o: unknown) => unknown }, id: string) {
        queryClient.getQueryData(["user", id]);
        queryClient.prefetchQuery({ queryKey: ["user", id] });
        mutate(["user", id]);
      }
    `,
    expectedCount: 3,
  },
  {
    name: "require-stable-snapshot (local getSnapshot binding, unstable selector, and reactive primitive in render)",
    rule: "antidrift/require-stable-snapshot",
    file: "tooling/antidrift/src/__probe_snapshot_bad.tsx",
    source: `
      import { useSyncExternalStore } from "react";
      declare function useStore<T>(store: unknown, selector: (s: { a: number }) => T, eq?: unknown): T;
      declare class QueryClient {}
      const getSnap = () => ({ val: 1 });
      export function App({ subscribe, store }: { subscribe: () => () => void; store: unknown }) {
        useSyncExternalStore(subscribe, getSnap);
        useStore(store, (s) => ({ a: s.a }));
        const client = new QueryClient();
        return <div>{String(Boolean(client))}</div>;
      }
    `,
    expectedCount: 3,
  },
  {
    name: "require-stable-snapshot (equality comparator and Next.js async Server Component stay clean)",
    rule: "antidrift/require-stable-snapshot",
    file: "tooling/antidrift/src/__probe_snapshot_good.tsx",
    source: `
      declare function useStore<T>(store: unknown, selector: (s: { a: number }) => T, eq?: unknown): T;
      declare const shallow: unknown;
      declare class QueryClient { prefetchQuery(): Promise<void>; }
      export function ClientView({ store }: { store: unknown }) {
        const slice = useStore(store, (s) => ({ a: s.a }), shallow);
        return <div>{slice.a}</div>;
      }
      export default async function ServerPage() {
        const queryClient = new QueryClient();
        await queryClient.prefetchQuery();
        return <div />;
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-hookless-use-function (platform sibling .web.ts stub with .native.ts hook stays clean)",
    rule: "antidrift/no-hookless-use-function",
    file: "tooling/antidrift/src/__probe_use_platform.web.ts",
    source: `
      export function useNativeBiometrics() {
        return;
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-unstable-render-default-collection (component default prop and hook inline fallback reported)",
    rule: "antidrift/no-unstable-render-default-collection",
    file: "tooling/antidrift/src/__probe_default_coll.tsx",
    source: `
      export function ModelList({ items = [], filter = new Map() }: { items?: string[]; filter?: Map<string, string> }) {
        return <div>{items.length + filter.size}</div>;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-query-envelope-leak (opaque helper argument and composite hook return reported)",
    rule: "antidrift/no-query-envelope-leak",
    file: "tooling/antidrift/src/__probe_query_leak_bad.tsx",
    source: `
      type UseQueryResult<T> = {
        data: T | undefined;
        error: Error | null;
        status: "pending" | "error" | "success";
        fetchStatus: "fetching" | "paused" | "idle";
        isLoading: boolean;
        isPending: boolean;
        isSuccess: boolean;
        isError: boolean;
        refetch: () => Promise<unknown>;
      };
      declare function useQuery<T>(): UseQueryResult<T>;
      function computeState(q: UseQueryResult<string[]>) {
        return { items: q.data ?? [], ready: q.isSuccess };
      }
      export function useModels() {
        const query = useQuery<string[]>();
        return { query, items: query.data ?? [] };
      }
      export function ModelsView() {
        const query = useQuery<string[]>();
        const items = computeState(query);
        return <div>{items.length}</div>;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-query-envelope-leak (direct query return and unpacked fields stay clean)",
    rule: "antidrift/no-query-envelope-leak",
    file: "tooling/antidrift/src/__probe_query_leak_good.tsx",
    source: `
      type UseQueryResult<T> = {
        data: T | undefined;
        error: Error | null;
        status: "pending" | "error" | "success";
        fetchStatus: "fetching" | "paused" | "idle";
        isLoading: boolean;
        isPending: boolean;
        isSuccess: boolean;
        isError: boolean;
        refetch: () => Promise<unknown>;
      };
      declare function useQuery<T>(): UseQueryResult<T>;
      export function useDirectModels() {
        const query = useQuery<string[]>();
        return query;
      }
      export function useUnpackedModels() {
        const query = useQuery<string[]>();
        return { data: query.data, isLoading: query.isLoading };
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-impure-render-call (direct call, default param, cross-module omitted default, and 1-hop helper reported)",
    rule: "antidrift/no-impure-render-call",
    file: "tooling/antidrift/src/__probe_impure_bad.tsx",
    source: `
      import { formatNow, relativeAge } from "./__probe_helpers.js";
      export function ClockView({ timestamp = Date.now(), updatedAt }: { timestamp?: number; updatedAt: number }) {
        const direct = Math.random();
        const age = relativeAge(updatedAt);
        const formatted = formatNow();
        return <div>{timestamp + direct + age + formatted}</div>;
      }
    `,
    expectedCount: 4,
  },
  {
    name: "no-impure-render-call (useState lazy init, explicit now arg, and async Next.js Server Component stay clean)",
    rule: "antidrift/no-impure-render-call",
    file: "tooling/antidrift/src/__probe_impure_good.tsx",
    source: `
      import { useState, useEffect } from "react";
      import { relativeAge } from "./__probe_helpers.js";
      export function CleanClockView({ updatedAt, currentNow }: { updatedAt: number; currentNow: number }) {
        const [mountedAt] = useState(() => Date.now());
        useEffect(() => {
          const tick = Date.now();
          void tick;
        }, []);
        const age = relativeAge(updatedAt, currentNow);
        return <button onClick={() => console.log(Date.now())}>{mountedAt + age}</button>;
      }
      export default async function NextServerPage() {
        const requestStartedAt = Date.now();
        const requestId = crypto.randomUUID();
        return <div>{requestStartedAt}:{requestId}</div>;
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-external-decode-in-tsx (flags wire JSON.parse in TSX while allowing component-local useState form validation)",
    rule: "antidrift/no-external-decode-in-tsx",
    file: "tooling/antidrift/src/__probe_external_decode.tsx",
    source: `
      import { useState } from "react";
      import { z } from "zod";
      const FormSchema = z.object({ name: z.string() });
      export function ProfileView({ wirePayload }: { wirePayload: string }) {
        const [draftName] = useState("");
        const parsedWire = JSON.parse(wirePayload);
        const validLocal = FormSchema.safeParse({ name: draftName });
        return <div>{String(Boolean(parsedWire && validLocal.success))}</div>;
      }
    `,
    expectedCount: 1,
  },
];
