export const portableCases = [
  {
    name: "no-wrapping-functions",
    invalid: "export const loadItems = (id) => owner.load(id);",
    valid:
      "export const area = (radius) => Math.PI * radius ** 2; button.onClick(() => owner.load(id));",
  },
  {
    name: "no-bun-api-in-shared",
    filename: "packages/shared/portability.ts",
    invalid: 'import { file } from "bun";',
    valid: 'import { read } from "./runtime-adapter";',
  },
  {
    name: "no-duplicate-context",
    invalid: "function loadUserUser() {}",
    valid: "function loadUser() {}",
  },
  {
    name: "no-ai-debt-comments",
    invalid:
      "// TODO clean up AI generated workaround\nexport const value = 1;",
    valid: "// The generator owns this mapping.\nexport const value = 1;",
  },
  {
    name: "no-as-never",
    invalid: "prepareStep({ steps: [toolStep] as never });",
    valid: "prepareStep({ steps: [toolStep] });",
  },
  {
    name: "no-todo-without-issue",
    invalid: "// TODO(verify): confirm remote audio track rendering\nstart();",
    valid: "// TODO(APP-42): confirm remote audio track rendering\nstart();",
  },
  {
    name: "no-generic-module-names",
    filename: "shared.ts",
    invalid: "export const token = 1;",
    valid: "export const token = 1;",
    validFilename: "tokens.ts",
  },
  {
    name: "no-default-export-in-domain",
    filename: "domain/entity.ts",
    invalid: "export default class Entity {}",
    valid: "export class Entity {}",
  },
  {
    name: "no-anemic-errors",
    invalid: 'throw new Error("Something went wrong");',
    valid: "throw new RequestError({ status, cause });",
  },
  {
    name: "no-relative-cross-package-imports",
    filename: "apps/client/src/main.ts",
    invalid: 'import { secret } from "../../other/src/internal";',
    valid: 'import { shared } from "@homer/shared";',
  },
  {
    name: "no-trivial-property-helpers",
    invalid: "function getStringValue(value) { return value.name ?? ''; }",
    valid: "function userName(value) { return value.name; }",
  },
  {
    name: "no-tutorial-comments",
    invalid:
      "// This function returns the value\nfunction value() { return 1; }",
    valid:
      "// The wire protocol uses big endian order.\nfunction value() { return 1; }",
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
      'import { useSyncExternalStore } from "react"; useSyncExternalStore(subscribe, () => store.snapshot);',
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
];
