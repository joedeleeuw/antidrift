import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { portableCases } from "./portable-cases.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const binaryPath = resolve(repoRoot, "target/debug/antidrift-linter");

execFileSync("cargo", ["build", "--bin", "antidrift-linter", "--quiet"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const registeredRulesOutput = execFileSync(binaryPath, ["--list-rules"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const registeredRules = new Set(
  registeredRulesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
);

const batchRuleIds = new Set(
  portableCases.map((entry) => `antidrift/${entry.name}`)
);
const batchInputs = [];
const expectations = new Map();
const sourceWorkspace = mkdtempSync(join(tmpdir(), "antidrift-rust-source-"));
process.on("exit", () =>
  rmSync(sourceWorkspace, { recursive: true, force: true })
);
for (const [directory, manifest] of [
  [
    "apps/client",
    { name: "@homer/client", dependencies: { "@homer/shared": "workspace:*" } },
  ],
  ["apps/other", { name: "@homer/other" }],
  ["packages/shared", { name: "@homer/shared" }],
]) {
  mkdirSync(join(sourceWorkspace, directory, "src"), { recursive: true });
  writeFileSync(
    join(sourceWorkspace, directory, "package.json"),
    JSON.stringify(manifest)
  );
}

for (const entry of portableCases) {
  const fullRuleId = `antidrift/${entry.name}`;
  if (!batchRuleIds.has(fullRuleId)) {
    continue;
  }
  const invalidId = `${entry.name}:invalid`;
  const validId = `${entry.name}:valid`;
  const invalidFilename = join(
    sourceWorkspace,
    entry.filename ?? "component.tsx"
  );
  const validFilename = join(
    sourceWorkspace,
    entry.validFilename ?? entry.filename ?? "component.tsx"
  );

  batchInputs.push({
    id: invalidId,
    filename: invalidFilename,
    sourceText: entry.invalid,
    rule: fullRuleId,
    options: entry.options ?? null,
  });
  expectations.set(invalidId, {
    ruleId: fullRuleId,
    expectedCount: entry.occurrences ?? 1,
  });

  batchInputs.push({
    id: validId,
    filename: validFilename,
    sourceText: entry.valid,
    rule: fullRuleId,
    options: entry.validOptions ?? entry.options ?? null,
  });
  expectations.set(validId, {
    ruleId: fullRuleId,
    expectedCount: 0,
  });
}

writeFileSync(
  join(sourceWorkspace, "states.ts"),
  'export const states = ["ready", "done"] as const;\n'
);

const boundaryProbes = [
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
    filename: join(sourceWorkspace, "Table.tsx"),
    expectedCount: 1,
  },
  {
    id: "duplicated-classnames:invalid",
    rule: "antidrift/no-duplicated-conditional-classnames",
    sourceText:
      'export function Badge({ active }: { active: boolean }) { return <div className={active ? "flex items-center gap-2 px-2 text-red-500" : "flex items-center gap-2 px-2 text-blue-500"} />; }\n',
    filename: join(sourceWorkspace, "Badge.tsx"),
    expectedCount: 1,
  },
  {
    id: "resource-lifecycle:invalid",
    rule: "antidrift/no-handrolled-resource-lifecycle-cells",
    sourceText:
      'import { useState } from "react";\nexport function UsersView() {\n  const [users, setUsers] = useState([]);\n  const [loading, setLoading] = useState(false);\n  const [error, setError] = useState(null);\n  async function load() {\n    setLoading(true);\n    try {\n      const result = await fetch("/api/users");\n      setUsers(result);\n    } catch (err) {\n      setError(err);\n    } finally {\n      setLoading(false);\n    }\n  }\n  return <button onClick={load}>{loading ? "Loading" : error ? "Error" : users.length}</button>;\n}\n',
    filename: join(sourceWorkspace, "UsersView.tsx"),
    expectedCount: 1,
  },
  {
    id: "effect-deps:invalid",
    rule: "antidrift/require-effect-deps",
    sourceText:
      'import { useEffect } from "react";\nexport function View() { useEffect(() => { console.log("hi"); }); return null; }\n',
    filename: join(sourceWorkspace, "View.tsx"),
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
    id: "repo-state-mirror:invalid",
    rule: "antidrift/no-repo-state-mirror-assertion",
    sourceText:
      'import { readFileSync } from "node:fs";\nexpect(readFileSync("src/index.ts", "utf8")).toContain("export");\n',
    filename: join(sourceWorkspace, "mirror.test.ts"),
    expectedCount: 1,
  },
  {
    id: "nonindependent-oracle:invalid",
    rule: "antidrift/no-nonindependent-test-oracle",
    sourceText: 'expect(names.includes("needle")).toBe(true);\n',
    filename: join(sourceWorkspace, "oracle.test.ts"),
    expectedCount: 1,
  },
];
for (const { expectedCount, filename, ...probe } of boundaryProbes) {
  batchInputs.push({
    ...probe,
    filename: filename ?? join(sourceWorkspace, "boundary.ts"),
  });
  expectations.set(probe.id, { ruleId: probe.rule, expectedCount });
}

const rawBatchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
  cwd: repoRoot,
  input: JSON.stringify(batchInputs),
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const batchResults = JSON.parse(rawBatchOutput);
assert.equal(batchResults.length, batchInputs.length);

for (const outcome of batchResults) {
  const expected = expectations.get(outcome.id);
  assert.ok(expected, `Missing expectation for ${outcome.id}`);
  assert.equal(
    outcome.diagnostics.length,
    expected.expectedCount,
    `Case ${outcome.id} expected ${expected.expectedCount} diagnostics, got ${JSON.stringify(outcome.diagnostics)}`
  );
  for (const diag of outcome.diagnostics) {
    assert.equal(diag.ruleId, expected.ruleId);
  }
}

function parseHeadlessOutput(buf) {
  const diagnostics = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const kind = buf.readUInt8(offset + 4);
    const payloadText = buf
      .subarray(offset + 5, offset + 5 + length)
      .toString("utf8");
    offset += 5 + length;
    if (kind === 1) {
      diagnostics.push(JSON.parse(payloadText));
    } else if (kind === 0) {
      throw new Error(`Headless protocol error: ${payloadText}`);
    }
  }
  return diagnostics;
}

function runHeadlessProbe(payload, extraEnv = {}) {
  const proc = spawnSync(binaryPath, ["headless"], {
    cwd: repoRoot,
    input: Buffer.from(JSON.stringify(payload), "utf8"),
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = parseHeadlessOutput(proc.stdout ?? Buffer.alloc(0));
  if (proc.status !== 0) {
    throw new Error(
      `Headless process exited with ${proc.status}: ${(proc.stderr ?? Buffer.alloc(0)).toString("utf8")}`
    );
  }
  return parsed;
}

const probeFileA = resolve(repoRoot, "tooling/antidrift/src/__probe_a.ts");
const probeFileB = resolve(repoRoot, "tooling/antidrift/src/__probe_b.ts");

const headlessProbes = [
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
    name: "no-unsafe-deserialize (alias-to-contract)",
    rule: "antidrift/no-unsafe-deserialize",
    source: `
      type Account = { id: string };
      export function parseAccount(text: string) {
        const raw = JSON.parse(text);
        const account: Account = raw;
        return account.id;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-identity-schema-transform (direct identity x => x)",
    rule: "antidrift/no-identity-schema-transform",
    source: `
      import { z } from "zod";
      export const schema = z.string().transform((value) => value);
    `,
    expectedCount: 1,
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
    name: "no-sql-string-concat (English prose with update and set stays clean)",
    rule: "antidrift/no-sql-string-concat",
    source: `
      export function describeAction(name: string) {
        return "Please update your profile before you set " + name;
      }
    `,
    expectedCount: 0,
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
];

const sharedHelperFiles = {
  [resolve(repoRoot, "tooling/antidrift/src/__probe_helpers.ts")]: `
    export function relativeAge(updatedAt: number, now = Date.now()): number {
      return now - updatedAt;
    }
    export function formatNow(): number {
      return Date.now();
    }
  `,
  [resolve(repoRoot, "tooling/antidrift/src/__probe_use_platform.native.ts")]: `
    import { useState } from "react";
    export function useNativeBiometrics() {
      const [supported] = useState(true);
      return { supported };
    }
  `,
};

const combinedConfigs = Object.keys(sharedHelperFiles).map((filePath) => ({
  file_paths: [filePath],
  rules: [],
}));
const combinedOverrides = { ...sharedHelperFiles };
const probeFiles = headlessProbes.map((probe, idx) => {
  const filePath = probe.file
    ? resolve(repoRoot, probe.file)
    : resolve(repoRoot, `tooling/antidrift/src/__probe_case_${idx}.ts`);
  combinedConfigs.push({
    file_paths: [filePath],
    rules: [{ name: probe.rule }],
  });
  combinedOverrides[filePath] = probe.source;
  return filePath;
});

const allProbeDiags = runHeadlessProbe({
  version: 2,
  configs: combinedConfigs,
  source_overrides: combinedOverrides,
});

for (const [idx, probe] of headlessProbes.entries()) {
  const filePath = probeFiles[idx];
  const diags = allProbeDiags.filter((diag) => diag.file_path === filePath);
  assert.equal(
    diags.length,
    probe.expectedCount,
    `Headless probe '${probe.name}' expected ${probe.expectedCount} diagnostics, got ${JSON.stringify(diags)}`
  );
}

const sqlDefaultDiags = runHeadlessProbe(
  {
    version: 2,
    configs: [
      {
        file_paths: [probeFileA],
        rules: [{ name: "no-floating-promises" }],
      },
    ],
    source_overrides: {
      [probeFileA]: `
        export function queryUser(userId: string) {
          return \`SELECT id FROM users WHERE id = \${userId}\`;
        }
      `,
    },
  },
  { ANTIDRIFT_TSGOLINT_DEFAULTS: "1" }
);
assert.equal(
  sqlDefaultDiags.filter(
    (diag) => diag.message?.id === "antidrift/no-sql-string-concat"
  ).length,
  1,
  `Expected default native rules to report antidrift/no-sql-string-concat, got ${JSON.stringify(sqlDefaultDiags)}`
);

const perFileIsolationDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [probeFileA],
      rules: [{ name: "antidrift/no-compat-names" }],
    },
    {
      file_paths: [probeFileB],
      rules: [],
    },
  ],
  source_overrides: {
    [probeFileA]: "export const cleanName = 1;\n",
    [probeFileB]: "export const legacyAdapter = 1;\n",
  },
});
assert.equal(
  perFileIsolationDiags.length,
  0,
  `Per-file config isolation failed: ${JSON.stringify(perFileIsolationDiags)}`
);

assert.ok(
  registeredRules.has("antidrift/no-vague-names"),
  "Expected --list-rules to include antidrift/no-vague-names"
);

const emptyFilesScopeDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [probeFileA],
      rules: [{ name: "antidrift/no-compat-names", options: [{ files: [] }] }],
    },
  ],
  source_overrides: {
    [probeFileA]: "export const legacyAdapter = 1;\n",
  },
});
assert.equal(
  emptyFilesScopeDiags.length,
  0,
  `Expected files: [] to match 0 files, got ${JSON.stringify(emptyFilesScopeDiags)}`
);

assert.throws(
  () =>
    runHeadlessProbe({
      version: 2,
      configs: [
        {
          file_paths: [probeFileA],
          rules: [
            {
              name: "antidrift/react-max-component-props",
              options: [{ max: 0 }],
            },
          ],
        },
      ],
      source_overrides: {
        [probeFileA]: "export const x = 1;\n",
      },
    }),
  /max must be >= 1/
);

assert.throws(
  () =>
    runHeadlessProbe({
      version: 2,
      configs: [
        {
          file_paths: [probeFileA],
          rules: [
            {
              name: "antidrift/no-compat-names",
              options: [{ files: ["["] }],
            },
          ],
        },
      ],
      source_overrides: {
        [probeFileA]: "export const x = 1;\n",
      },
    }),
  /invalid glob/
);

const missingPathRun = spawnSync(
  binaryPath,
  ["nonexistent-smoke-target-file.ts"],
  {
    cwd: repoRoot,
    encoding: "utf8",
  }
);
assert.notEqual(
  missingPathRun.status,
  0,
  "Expected missing CLI path to fail with non-zero exit code"
);

const tempWorkspace = mkdtempSync(join(tmpdir(), "antidrift-rust-smoke-"));
try {
  const kernelSrc = join(tempWorkspace, "crates/antidrift-kernel/src");
  mkdirSync(kernelSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-kernel/Cargo.toml"),
    [
      "[package]",
      'name = "antidrift-kernel"',
      'version = "0.20.0"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "test = false",
      "",
      "[lints]",
      "workspace = true",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(kernelSrc, "lib.rs"),
    "pub mod boundary;\npub mod provenance;\n"
  );
  writeFileSync(join(kernelSrc, "boundary.rs"), "pub struct BoundaryItem;\n");
  writeFileSync(
    join(kernelSrc, "provenance.rs"),
    [
      "use crate::{",
      "    boundary::BoundaryItem,",
      "};",
      "use serde::Deserialize;",
      "use std::collections::HashMap;",
      "// forbidden inline comment",
      "#[derive(Deserialize)]",
      "pub struct LooseConfig {",
      "    pub kind: String,",
      "    pub exclude_files: Vec<String>,",
      "    pub seen: HashMap<String, bool>,",
      "    pub item: Option<BoundaryItem>,",
      "}",
      "pub fn decode_rule_options(name: &str) -> Result<usize, String> {",
      "    Ok(name.len())",
      "}",
      "pub fn legacy_adapter(input: &str) -> Result<usize, String> {",
      "    decode_rule_options(input)?;",
      '    input.parse::<usize>().map_err(|_| "parse failed".to_string())',
      "}",
      "pub fn hop_wrapper(input: &str) -> Result<usize, String> {",
      "    let _ = input;",
      "    legacy_adapter(input)",
      "}",
      "pub struct Holder { pub ident: String }",
      "pub fn compare_ident(h: &Holder, val: &serde_json::Value) -> bool {",
      '    let _ = val["k"].as_str();',
      '    h.ident.to_string() == "foo"',
      "}",
      "#[cfg(all(test))]",
      "mod inline_tests {}",
      "",
    ].join("\n")
  );
  writeFileSync(join(kernelSrc, "orphan_file.rs"), "pub fn unused() {}\n");
  writeFileSync(join(kernelSrc, "bad_helpers.rs"), "pub fn helper() {}\n");

  const rustSubcmd = spawnSync(binaryPath, ["rust", "--json", tempWorkspace], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    rustSubcmd.status,
    1,
    `Expected antidrift-linter rust to exit 1 on violations, got ${rustSubcmd.status}: ${rustSubcmd.stderr}`
  );
  const rustDiags = JSON.parse(rustSubcmd.stdout);
  const reportedRuleIds = new Set(rustDiags.map((diag) => diag.ruleId));
  for (const expectedRuleId of [
    "rust/target-manifest-policy",
    "rust/no-inline-comment",
    "rust/no-layer-violation",
    "rust/require-strict-serde",
    "rust/no-stringly-variant",
    "rust/no-boolean-map",
    "rust/no-orphan-module",
    "rust/no-grab-bag-module",
    "rust/no-anemic-errors",
    "rust/no-compat-names",
    "rust/no-wrapping-functions",
    "rust/no-duplicate-scope-fields",
    "rust/no-discarded-decoded-config",
    "rust/no-let-underscore-suppression",
    "rust/no-ident-to-string-compare",
    "rust/no-untyped-config-probe",
    "rust/no-inline-tests",
  ]) {
    assert.ok(
      reportedRuleIds.has(expectedRuleId),
      `Expected antidrift-linter rust to report ${expectedRuleId}, got ${JSON.stringify(rustDiags)}`
    );
  }
} finally {
  rmSync(tempWorkspace, { recursive: true, force: true });
}

console.log(
  `✓ antidrift-linter Rust smoke passed (${registeredRules.size} rules registered, ${batchResults.length} portable batch cases + ${headlessProbes.length + 2} native tsrslint headless probes + failure-path & rust linter smokes verified)`
);
