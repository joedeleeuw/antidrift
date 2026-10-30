const boundaryProbeRows = [
  {
    id: "authz:missing",
    rule: "antidrift/require-authz-check",
    sourceText: "function handle(req) { return req.params.id; }",
    options: { authzFunctions: ["authorize"] },
    expectedCount: 1,
  },
  {
    id: "authz:checked",
    rule: "antidrift/require-authz-check",
    sourceText:
      "function handle(req) { authorize(req); return req.params.id; }",
    options: { authzFunctions: ["authorize"] },
    expectedCount: 0,
  },
  {
    id: "authz:nested-frame",
    rule: "antidrift/require-authz-check",
    sourceText:
      "function handle(req) { const check = () => authorize(req); return req.params.id; }",
    options: { authzFunctions: ["authorize"] },
    expectedCount: 1,
  },
  {
    id: "authz:bracket-params",
    rule: "antidrift/require-authz-check",
    sourceText: 'function handle(req) { return req["params"]["id"]; }',
    options: { authzFunctions: ["authorize"] },
    expectedCount: 1,
  },
  {
    id: "authz:direct-params",
    rule: "antidrift/require-authz-check",
    sourceText: "export function GET(_req, { params }) { return params.id; }",
    options: { authzFunctions: ["authorize"] },
    expectedCount: 1,
  },
  {
    id: "owned-union:local",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText:
      'export const states = ["ready", "done"] as const; type State = "done" | "ready";',
    expectedCount: 1,
  },
  {
    id: "owned-union:derived",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText:
      'export const states = ["ready", "done"] as const; type State = typeof states[number];',
    expectedCount: 0,
  },
  {
    id: "owned-union:imported",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText:
      'import { states } from "./states.js"; type State = "ready" | "done";',
    expectedCount: 1,
  },
  {
    id: "owned-union:shadowed",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText:
      'import { states } from "./states.js"; function scope(states: unknown) { type State = "ready" | "done"; }',
    expectedCount: 0,
  },
  {
    id: "owned-union:convex",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText:
      'import { v } from "convex/values"; import { states } from "./states.js"; const validator = v.union(v.literal("ready"), v.literal("done"));',
    expectedCount: 1,
  },
  {
    id: "owned-union:status-context",
    rule: "antidrift/no-redeclared-owned-union",
    sourceText: 'type Job = { status: "ready" }; type Other = "ready";',
    options: {
      statuses: {
        JobStatus: { owner: "states.ts", values: ["ready", "done"] },
      },
    },
    expectedCount: 1,
  },
  {
    id: "unknown-type-aliases:invalid",
    rule: "antidrift/no-unknown-type-aliases",
    sourceText: "type MysteryPayload = unknown;\n",
    expectedCount: 1,
  },
  {
    id: "unsafe-cast-chain:invalid",
    rule: "antidrift/no-unsafe-cast-chain",
    sourceText: "const out = raw as unknown as string;\n",
    expectedCount: 1,
  },
  {
    id: "calling-components:invalid",
    rule: "antidrift/no-calling-components-as-functions",
    sourceText:
      "function Row() { return <div />; }\nexport function Table() { return <div>{Row()}</div>; }\n",
    file: "Table.tsx",
    expectedCount: 1,
  },
  {
    id: "duplicated-classnames:invalid",
    rule: "antidrift/no-duplicated-conditional-classnames",
    sourceText:
      'export function Badge({ active }: { active: boolean }) { return <div className={active ? "flex items-center gap-2 px-2 text-red-500" : "flex items-center gap-2 px-2 text-blue-500"} />; }\n',
    file: "Badge.tsx",
    expectedCount: 1,
  },
  {
    id: "resource-lifecycle:invalid",
    rule: "antidrift/no-handrolled-resource-lifecycle-cells",
    sourceText:
      'import { useState } from "react";\nexport function UsersView() {\n  const [users, setUsers] = useState([]);\n  const [loading, setLoading] = useState(false);\n  const [error, setError] = useState(null);\n  async function load() {\n    setLoading(true);\n    try {\n      const result = await fetch("/api/users");\n      setUsers(result);\n    } catch (err) {\n      setError(err);\n    } finally {\n      setLoading(false);\n    }\n  }\n  const [state, setState] = useState({ entries: [], loading: false, error: null });\n  async function search() {\n    setState((prev) => ({ ...prev, loading: true, error: null }));\n    try {\n      const payload = await fetch("/api/search");\n      setState({ entries: payload, loading: false, error: null });\n    } catch (err) {\n      setState({ entries: [], loading: false, error: String(err) });\n    }\n  }\n  return <button onClick={() => { void load(); void search(); }}>{loading || state.loading ? "Loading" : error || state.error ? "Error" : users.length}</button>;\n}\n',
    file: "UsersView.tsx",
    expectedCount: 2,
  },
  {
    id: "resource-lifecycle:process-loa",
    rule: "antidrift/no-handrolled-resource-lifecycle-cells",
    sourceText:
      'import { spawn } from "node:child_process";\nimport { spawnTracked } from "./process";\ndeclare function waitFor(pred: () => boolean): Promise<void>;\nconst holdScript = "import fcntl, time\\nfcntl.flock(f, fcntl.LOCK_EX)\\nprint(\\"held\\")\\ntime.sleep(600)";\nexport async function runProbe(proc: { stdout: { on: (ev: string, cb: (chunk: string) => void) => void } }) {\n  spawnTracked("helper");\n  spawn("python3", ["-c", holdScript]);\n  let output = "";\n  proc.stdout.on("data", (chunk) => { output += chunk; });\n  await waitFor(() => output.includes("held"));\n}\nexport async function cleanupAll(a: () => Promise<void>, b: () => Promise<void>, c: () => Promise<void>, d: () => Promise<void>) {\n  try { await a(); } finally { try { await b(); } finally { try { await c(); } finally { await d(); } } }\n}\n',
    file: "process-loa.ts",
    expectedCount: 4,
  },
  {
    id: "resource-lifecycle:bound-method-init-clean",
    rule: "antidrift/no-handrolled-resource-lifecycle-cells",
    sourceText:
      'import { useState, useEffect } from "react";\nexport function SyncedView({ store }: { store: { getSnapshot: () => number; subscribe: (cb: () => void) => () => void } }) {\n  const [snap, setSnap] = useState(store.getSnapshot);\n  useEffect(() => store.subscribe(() => setSnap(store.getSnapshot())), [store]);\n  return <div>{snap}</div>;\n}\n',
    file: "SyncedView.tsx",
    expectedCount: 0,
  },
  {
    id: "reexport-only:tool-config",
    rule: "antidrift/no-reexport-only-module",
    sourceText: 'export { default } from "@homer/shared/prettier";\n',
    file: "prettier.config.mjs",
    expectedCount: 0,
  },
  {
    id: "effect-deps:invalid",
    rule: "antidrift/require-effect-deps",
    sourceText:
      'import { useEffect } from "react";\nexport function View() { useEffect(() => { console.log("hi"); }); return null; }\n',
    file: "View.tsx",
    expectedCount: 1,
  },
  {
    id: "async-array-method:invalid",
    rule: "antidrift/no-async-array-method",
    sourceText: "items.forEach(async (item) => { await save(item); });\n",
    expectedCount: 1,
  },
  {
    id: "sentinel-fallback:invalid",
    rule: "antidrift/no-sentinel-absence-fallback",
    sourceText: 'export const label = user.name ?? "Unknown";\n',
    expectedCount: 1,
  },
  {
    id: "sentinel-fallback:catch-sentinel",
    rule: "antidrift/no-sentinel-absence-fallback",
    sourceText:
      'async function readTrace(p: string) { try { return await readFile(p); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return ""; throw e; } }\n',
    expectedCount: 1,
  },
  {
    id: "sentinel-fallback:catch-boolean-clean",
    rule: "antidrift/no-sentinel-absence-fallback",
    sourceText:
      "async function exists(p: string) { try { await stat(p); return true; } catch { return false; } }\n",
    expectedCount: 0,
  },
  {
    id: "sentinel-fallback:multi-tier-artifact-invalid",
    rule: "antidrift/no-sentinel-absence-fallback",
    sourceText:
      'import { existsSync } from "node:fs";\nexport function findBinary() { const candidates = ["dist/bin/tool", "target/release/tool", "target/debug/tool"]; return candidates.find((p) => existsSync(p)); }\n',
    expectedCount: 1,
  },
  {
    id: "sentinel-fallback:multi-tier-artifact-mtime-clean",
    rule: "antidrift/no-sentinel-absence-fallback",
    sourceText:
      'import { existsSync, statSync } from "node:fs";\nexport function findBinary() { const candidates = ["target/release/tool", "target/debug/tool"].filter((p) => existsSync(p)); candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); return candidates.find((p) => existsSync(p)); }\n',
    expectedCount: 0,
  },
  {
    id: "repo-state-mirror:invalid",
    rule: "antidrift/no-repo-state-mirror-assertion",
    sourceText:
      'import { readFileSync } from "node:fs";\nexpect(readFileSync("src/index.ts", "utf8")).toContain("export");\n',
    file: "mirror.test.ts",
    expectedCount: 1,
  },
  {
    id: "nonindependent-oracle:invalid",
    rule: "antidrift/no-nonindependent-test-oracle",
    sourceText: 'expect(names.includes("needle")).toBe(true);\n',
    file: "oracle.test.ts",
    expectedCount: 1,
  },
  {
    id: "react-max-component-props:invalid",
    rule: "antidrift/react-max-component-props",
    sourceText:
      "export function OverloadedCard({ a, b, c }: { a: string; b: string; c: string }) { return <div>{a}{b}{c}</div>; }\n",
    file: "OverloadedCard.tsx",
    options: { max: 2 },
    expectedCount: 1,
  },
  {
    id: "role:script-entry-dir",
    rule: "antidrift/no-eager-singleton",
    sourceText: "const storage = new S3Client({});\n",
    file: "scripts/seed.ts",
    expectedCount: 0,
  },
  {
    id: "role:worker-process-entry",
    rule: "antidrift/no-eager-singleton",
    sourceText: "const storage = new S3Client({});\n",
    file: "src/terminal/terminal-worker-process.ts",
    expectedCount: 0,
  },
  {
    id: "role:outside-shared",
    rule: "antidrift/no-bun-api-in-shared",
    sourceText: 'import { file } from "bun";\n',
    file: "packages/server/portability.ts",
    expectedCount: 0,
  },
  {
    id: "role:host-path-example",
    rule: "antidrift/no-host-path-literal",
    sourceText: 'const root = "/Users/alice/code/app";\n',
    file: "examples/demo.ts",
    expectedCount: 0,
  },
  {
    id: "role:host-path-e2e",
    rule: "antidrift/no-host-path-literal",
    sourceText: 'const root = "/Users/alice/code/app";\n',
    file: "app/e2e/flow.ts",
    expectedCount: 0,
  },
  {
    id: "role:host-path-story",
    rule: "antidrift/no-host-path-literal",
    sourceText: 'const root = "/Users/alice/code/app";\n',
    file: "src/Button.stories.tsx",
    expectedCount: 0,
  },
  {
    id: "role:host-path-fixture",
    rule: "antidrift/no-host-path-literal",
    sourceText: 'const root = "/Users/alice/code/app";\n',
    file: "src/__fixtures__/paths.ts",
    expectedCount: 0,
  },
  {
    id: "role:tutorial-docs",
    rule: "antidrift/no-tutorial-comments",
    sourceText:
      "// This function returns the value\nfunction value() { return 1; }\n",
    file: "docs/guide.ts",
    expectedCount: 0,
  },
  {
    id: "role:tutorial-stub",
    rule: "antidrift/no-tutorial-comments",
    sourceText:
      "// This function returns the value\nfunction value() { return 1; }\n",
    file: "src/value.stub.ts",
    expectedCount: 0,
  },
];

export function buildBoundaryProbes(sourceWorkspace, join) {
  return boundaryProbeRows.map(({ file, ...probe }) =>
    file === undefined
      ? probe
      : { ...probe, filename: join(sourceWorkspace, file) }
  );
}
