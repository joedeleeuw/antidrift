import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBoundaryProbes,
  buildSharedHelperFiles,
  coreHeadlessProbes,
  portableCases,
} from "./portable-cases.mjs";

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

const boundaryProbes = buildBoundaryProbes(sourceWorkspace, join);
for (const { expectedCount, filename, ...probe } of boundaryProbes) {
  batchInputs.push({
    ...probe,
    filename: filename ?? join(sourceWorkspace, "boundary.ts"),
  });
  expectations.set(probe.id, { ruleId: probe.rule, expectedCount });
}

const rawBatchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
  cwd: repoRoot,
  input: JSON.stringify(
    batchInputs.map((input) => ({ cwd: sourceWorkspace, ...input }))
  ),
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const batchResults = JSON.parse(String(rawBatchOutput));
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

function runHeadlessProbe(payload, extraEnv = {}) {
  const proc = spawnSync(binaryPath, ["headless"], {
    cwd: repoRoot,
    input: Buffer.from(JSON.stringify(payload), "utf8"),
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    encoding: "buffer",
  });
  const buf = proc.stdout;
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
      diagnostics.push(JSON.parse(String(payloadText)));
    } else if (kind === 0) {
      throw new Error(`Headless protocol error: ${payloadText}`);
    }
  }
  if (proc.status !== 0) {
    throw new Error(
      `Headless process exited with ${proc.status}: ${(proc.stderr ?? Buffer.alloc(0)).toString("utf8")}`
    );
  }
  return diagnostics;
}

const probeFileA = resolve(repoRoot, "tooling/antidrift/src/__probe_a.ts");
const probeFileB = resolve(repoRoot, "tooling/antidrift/src/__probe_b.ts");

const headlessProbes = [
  ...coreHeadlessProbes,
  {
    name: "no-hypothetical-seam (implemented interface and abstract class with one production adapter reported)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_single.ts",
    source: `
      export interface Clock { now(): number }
      export class SystemClock implements Clock { now() { return Date.now(); } }
      export abstract class Store { abstract read(): string }
      export class MemoryStore extends Store { read() { return ""; } }
    `,
    expectedCount: 2,
  },
  {
    name: "no-hypothetical-seam (test adapter, two production adapters, and unimplemented data shape stay clean)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_multi.ts",
    source: `
      export interface Ticker { tick(): number }
      export class WallTicker implements Ticker { tick() { return Date.now(); } }
      export interface Sink { write(line: string): void }
      export class FileSink implements Sink { write(line: string) { void line; } }
      export class NetSink implements Sink { write(line: string) { void line; } }
      export interface Row { id: string }
    `,
    expectedCount: 0,
  },
  {
    name: "no-hypothetical-seam (effectful defaults only a test call site overrides reported)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_runner.ts",
    source: `
      import { execFileSync } from "node:child_process";
      export function runGit(args: string[], exec = execFileSync) {
        return exec("git", args);
      }
      export class Stamp {
        constructor(private readonly now = Date.now) {}
        at() { return this.now(); }
      }
      export function main() {
        runGit(["status"]);
        return new Stamp().at();
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-hypothetical-seam (production override and literal default stay clean)",
    rule: "antidrift/no-hypothetical-seam",
    file: "tooling/antidrift/src/__probe_seam_injected.ts",
    source: `
      import { execFileSync } from "node:child_process";
      export function runTool(args: string[], exec = execFileSync, retries = 3) {
        return exec("tool", args).length + retries;
      }
      export function dryRun() {
        return runTool(["--dry"], () => Buffer.from(""));
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-closed-string-parameter (includes/!== closed sets and bare-literal boolean mode flag reported)",
    rule: "antidrift/no-closed-string-parameter",
    file: "tooling/antidrift/src/__probe_closed_string.ts",
    source: `
      const MODES = ["fast", "slow"] as const;
      export function pickMode(mode: string) {
        if (!MODES.includes(mode as (typeof MODES)[number])) {
          throw new Error(\`unknown mode \${mode}\`);
        }
        return mode;
      }
      export function pickLevel(level: string) {
        if (level !== "info" && level !== "warn") {
          throw new Error("unknown level");
        }
        return level;
      }
      export function render(text: string, verbose: boolean) {
        if (verbose) {
          return text.toUpperCase();
        }
        return text;
      }
      export function main() {
        return render(pickMode("fast") + pickLevel("info"), true);
      }
    `,
    expectedCount: 3,
  },
  {
    name: "no-closed-string-parameter (unknown decoder, single literal, setter, stored flag, and variable flag argument stay clean)",
    rule: "antidrift/no-closed-string-parameter",
    file: "tooling/antidrift/src/__probe_closed_string_clean.ts",
    source: `
      export function decodeMode(mode: string, raw: unknown) {
        if (mode !== "a" && mode !== "b") {
          throw new Error("bad mode");
        }
        return raw;
      }
      export function requireA(mode: string) {
        if (mode !== "a") {
          throw new Error("bad mode");
        }
        return mode;
      }
      export function setEnabled(on: boolean) {
        return on ? 1 : 0;
      }
      export function stored(label: string, verbose: boolean) {
        const keep = verbose;
        return keep ? label : "";
      }
      export function quiet(text: string, verbose: boolean) {
        if (verbose) {
          return text;
        }
        return "";
      }
      export function callers(flag: boolean) {
        setEnabled(true);
        stored("x", false);
        return quiet("x", flag);
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-argument-mutation-side-effect (void writers into type literal, interface, Map, and Record arguments reported)",
    rule: "antidrift/no-argument-mutation-side-effect",
    file: "tooling/antidrift/src/__probe_argument_mutation.ts",
    source: `
      type Options = { retries: number; label?: string };
      interface Row { id: string; seen: boolean }
      export function applyDefaults(options: Options): void {
        options.retries = 3;
      }
      export function markSeen(row: Row) {
        row.seen = true;
      }
      export const tally = (counts: Map<string, number>, key: string) => {
        counts.set(key, 1);
      };
      export function bump(totals: Record<string, number>, key: string) {
        totals[key]++;
      }
    `,
    expectedCount: 4,
  },
  {
    name: "no-argument-mutation-side-effect (returned copy, accumulator name, service interface, rebind, and middleware stay clean)",
    rule: "antidrift/no-argument-mutation-side-effect",
    file: "tooling/antidrift/src/__probe_argument_mutation_clean.ts",
    source: `
      type Options = { retries: number };
      interface Service { run(): void; count: number }
      export function withDefaults(options: Options) {
        return { ...options, retries: 3 };
      }
      export function fill(acc: Record<string, number>) {
        acc.total = 1;
      }
      export function tick(service: Service) {
        service.count = 1;
      }
      export function rebind(options: Options) {
        options = { ...options };
        options.retries = 1;
      }
      export function middleware(req: Options, res: Options, next: () => void) {
        req.retries = res.retries;
        next();
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-query-join-or-tree-reshape (multiQueryRenderJoin: spread of two queries and nested machines.find lookup in render)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    file: "tooling/antidrift/src/__probe_query_join_feed.tsx",
    source: `
      declare function useQuery<T>(options: { queryKey: string[] }): { data: T | undefined };
      type Message = { id: string; machineId: string; createdAt: number };
      type Generation = { id: string; machineId: string; createdAt: number };
      type Machine = { id: string; name: string };
      export function ConversationFeed() {
        const { data: messages = [] } = useQuery<Message[]>({ queryKey: ["messages"] });
        const generations = useQuery<Generation[]>({ queryKey: ["generations"] }).data ?? [];
        const machinesQuery = useQuery<Machine[]>({ queryKey: ["machines"] });
        const machines = machinesQuery.data ?? [];
        const timeline = [...messages, ...generations].sort((a, b) => a.createdAt - b.createdAt);
        const rows = timeline.map((entry) => ({
          ...entry,
          machine: machines.find((machine) => machine.id === entry.machineId),
        }));
        return <ul>{rows.map((row) => <li key={row.id}>{row.machine?.name}</li>)}</ul>;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-query-join-or-tree-reshape (renderTreeFlattenReshape: nested and chained flatMap over a prop tree in render)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    file: "tooling/antidrift/src/__probe_tree_flatten.tsx",
    source: `
      type Line = { id: string; text: string };
      type Hunk = { id: string; lines: Line[] };
      type DiffFile = { path: string; hunks: Hunk[] };
      export function DiffView({ files }: { files: DiffFile[] }) {
        const lines = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
        const chained = files.flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines);
        return <pre>{lines.length + chained.length}</pre>;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-query-join-or-tree-reshape (sequentialAsyncWaterfall: three independent runGit reads awaited serially)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    file: "tooling/antidrift/src/__probe_await_waterfall.ts",
    source: `
      declare function runGit(cwd: string, args: string[]): Promise<string>;
      export async function inspectRepository(cwd: string) {
        const refs = await runGit(cwd, ["show-ref"]);
        const head = await runGit(cwd, ["rev-parse", "HEAD"]);
        const status = await runGit(cwd, ["status", "--porcelain"]);
        return { refs, head, status };
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-query-join-or-tree-reshape (dependent awaits, Promise.all, mutations, scalar selection in JSX map, one-level and memoized flattens stay clean)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    file: "tooling/antidrift/src/__probe_query_join_clean.tsx",
    source: `
      import { useMemo } from "react";
      declare function runGit(cwd: string, args: string[]): Promise<string>;
      declare function createBranch(cwd: string): Promise<string>;
      declare function setUpstream(cwd: string): Promise<string>;
      declare function pushBranch(cwd: string): Promise<string>;
      declare function useQuery<T>(options: { queryKey: string[] }): { data: T | undefined };
      type Item = { id: string; label: string; children: { id: string; leaves: string[] }[] };
      export async function inspectDependent(cwd: string) {
        const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
        const status = await runGit(root, ["status"]);
        const branch = await runGit(root, ["branch"]);
        return { status, branch };
      }
      export async function inspectBatched(cwd: string) {
        const [refs, head, status] = await Promise.all([
          runGit(cwd, ["show-ref"]),
          runGit(cwd, ["rev-parse"]),
          runGit(cwd, ["status"]),
        ]);
        return { refs, head, status };
      }
      export async function publishBranch(cwd: string) {
        const created = await createBranch(cwd);
        const tracked = await setUpstream(cwd);
        const pushed = await pushBranch(cwd);
        return { created, tracked, pushed };
      }
      export function SelectableList() {
        const { data: items = [] } = useQuery<Item[]>({ queryKey: ["items"] });
        const { data: selected } = useQuery<Item>({ queryKey: ["selected"] });
        const others = items.filter((item) => item.id !== selected?.id);
        const children = items.flatMap((item) => item.children);
        const flattened = items.flat();
        const leaves = useMemo(
          () => items.flatMap((item) => item.children.flatMap((child) => child.leaves)),
          [items]
        );
        return (
          <ul>
            {items.map((item) => (
              <li key={item.id} data-active={item.id === selected?.id}>{item.label}</li>
            ))}
            {others.length + children.length + flattened.length + leaves.length}
          </ul>
        );
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-sentinel-absence-fallback (dualEmptySentinel: object | string-literal | undefined tested with !x || x === sentinel)",
    rule: "antidrift/no-sentinel-absence-fallback",
    file: "tooling/antidrift/src/__probe_dual_sentinel.ts",
    source: `
      type BindingHolder = { phase: "claimed" | "reserved" | "released"; unitRecovery: boolean };
      declare function readBinding(): BindingHolder | "unbound" | undefined;
      declare function readClean(): BindingHolder | undefined;
      export function checkDualSentinel() { const holder = readBinding(); if (!holder || holder === "unbound") return false; return holder.unitRecovery; }
      export function checkPositiveDualSentinel() { const holder = readBinding(); if (holder && holder !== "unbound") return holder.unitRecovery; return false; }
      export function checkSingleEmptyRepresentation() { const holder = readClean(); if (!holder) return false; return holder.unitRecovery; }
    `,
    expectedCount: 2,
  },
  {
    name: "no-branch-tree (subjectCoupledBranchTree and negatedDiscriminantScatter on withLock pattern reported)",
    rule: "antidrift/no-branch-tree",
    file: "tooling/antidrift/src/__probe_branch_tree_bad.ts",
    source: `
      type Holder = { phase: "claimed" | "reserved" | "released"; unitRecovery: boolean };
      declare function readHubPortBinding(): Promise<Holder | "unbound" | undefined>;
      declare function foreign(holder: Holder): boolean;
      declare function write(phase: string, recovery: boolean): Promise<void>;
      export async function acquirePort() {
        const holder = await readHubPortBinding();
        if (holder && holder !== "unbound") {
          if (holder.phase !== "released" && foreign(holder)) throw new Error("foreign binding owns port authority");
          if (holder.phase !== "claimed") await write("reserved", foreign(holder) ? false : holder.unitRecovery);
        } else { await write("reserved", false); }
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-branch-tree (flat early-return guards, independent subjects, and switch over discriminant stay clean)",
    rule: "antidrift/no-branch-tree",
    file: "tooling/antidrift/src/__probe_branch_tree_clean.ts",
    source: `
      type Holder = { phase: "unbound" } | { phase: "claimed" | "reserved" | "released"; foreign: boolean; unitRecovery: boolean };
      declare function write(phase: string, recovery: boolean): Promise<void>;
      export async function acquireClean(holder: Holder) {
        if (holder.phase === "unbound") { await write("reserved", false); return; }
        if (holder.foreign && holder.phase !== "released") throw new Error("foreign binding owns port authority");
        switch (holder.phase) { case "claimed": return; case "reserved": case "released": await write("reserved", holder.foreign ? false : holder.unitRecovery); return; }
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-mutable-let-alias (settled let-to-const closure alias and staged const-to-let assignment reported)",
    rule: "antidrift/no-mutable-let-alias",
    file: "tooling/antidrift/src/__probe_mutable_let_alias_bad.ts",
    source: `
      declare function runStatus(): Promise<{ paths: { configPath: string } }>;
      declare function readOwner(id: string): string | undefined;
      export function settleOwner(id: string, fallback: string) {
        let owner = readOwner(id); if (!owner) owner = fallback;
        const userId = owner; return () => userId.trim();
      }
      export async function verifyHub() {
        let paths: { configPath: string } | undefined;
        try {
          const uninstalled = await runStatus(); const foreignPaths = uninstalled.paths; paths = foreignPaths;
          if (!foreignPaths.configPath) throw new Error("missing configPath");
        } finally { if (paths) paths.configPath.trim(); }
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-mutable-let-alias (pre-mutation snapshot, loop accumulator, and cancellation token stay clean)",
    rule: "antidrift/no-mutable-let-alias",
    file: "tooling/antidrift/src/__probe_mutable_let_alias_clean.ts",
    source: `
      export function rotateToken(next: string) {
        let current = "initial"; if (next.length > 0) current = next;
        const previous = current; current = "rotated"; return { previous, current };
      }
      export function sumItems(items: number[]) {
        let total = 0; for (const item of items) total += item;
        const finalTotal = total; return finalTotal * 2;
      }
      export async function runCancellable(work: (signal: AbortSignal) => Promise<void>) {
        let activeAbort: AbortController | null = null;
        if (!activeAbort) {
          const abort = new AbortController(); activeAbort = abort;
          await work(abort.signal); if (activeAbort === abort) activeAbort = null;
        }
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-contract-appeasement-projection (constantReturnField and sumToProductErasure vs sibling producer)",
    rule: "antidrift/no-contract-appeasement-projection",
    file: "tooling/antidrift/src/__probe_constant_return_field.ts",
    source: `
      export interface MachineReview { root: string; count: number; truncated: boolean; }
      export function reviewForProject(root: string, items: string[]): MachineReview {
        if (items.length === 0) return { root, count: 0, truncated: false };
        return { root, count: items.length, truncated: false };
      }
      export interface TimelinePage { rows: string[]; reset: boolean; }
      export function fetchAfter(rows: string[]): TimelinePage {
        if (rows.length === 0) return { rows: [], reset: false };
        return { rows, reset: false };
      }
      export function fetchReset(rows: string[]): TimelinePage {
        return { rows, reset: true };
      }
      export function toStatusBag(envId: string, result: { _tag: "Success" | "Failure"; waiting: boolean }) {
        return { envId, isPending: result.waiting, error: result._tag === "Failure" ? "failed" : null };
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-query-join-or-tree-reshape (non-React relational key lookup join)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    source: `
      export function joinProviders(
        selections: ReadonlyArray<{ instanceId: string; model: string }>,
        providers: ReadonlyArray<{ instanceId: string; ready: boolean }>,
      ) {
        return selections.map((sel) => ({
          model: sel.model,
          ready: providers.find((prov) => prov.instanceId === sel.instanceId)?.ready ?? false,
        }));
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-structural-type-fork (all-fields redundantOwnerPrefix reported while sibling-disambiguated fields and derived ReturnType aliases stay clean)",
    rule: "antidrift/no-structural-type-fork",
    file: "tooling/antidrift/src/__probe_redundant_owner_prefix.ts",
    source: `
      export interface ProjectDescriptor { projectId: string; projectKey: string; projectDisplayName: string; }
      export interface BusinessInfo { businessZipCode: string; personalZipCode: string; ownerName: string; }
      export type DerivedBusinessResult = Awaited<ReturnType<() => Promise<BusinessInfo>>>;
    `,
    expectedCount: 1,
  },
  {
    name: "no-service-constructor-imports (flags imported service constructor while helper and tag-consuming accessor stay clean)",
    rule: "antidrift/no-service-constructor-imports",
    file: "tooling/antidrift/src/__probe_service_consumer.ts",
    source: `
      import { makeUsersRepo, parseUserId, requireUsersScope, refineUsersScope } from "./__probe_helpers.js";
      export function runHandler(raw: string) {
        const repo = makeUsersRepo();
        return { repo, id: parseUserId(raw), req: requireUsersScope, ref: refineUsersScope };
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-schema-validator-transcoding (flags toJsonSchema in Convex args while native Convex validator stays clean)",
    rule: "antidrift/no-schema-validator-transcoding",
    file: "tooling/antidrift/src/__probe_schema_transcoding.ts",
    source: `
      import { query } from "./node_modules/convex/server.js";
      import { v } from "./node_modules/convex/values.js";
      import { toJsonSchema } from "./node_modules/@valibot/to-json-schema/index.js";
      export const badQuery = query({
        args: toJsonSchema({ id: "string" }),
        returns: v.string(),
        handler: () => "ok",
      });
      export const goodQuery = query({
        args: v.object({ id: v.string() }),
        returns: v.string(),
        handler: () => "ok",
      });
    `,
    expectedCount: 1,
  },
  {
    name: "require-convex-return-validator (flags missing returns and v.any() while explicit returns stays clean)",
    rule: "antidrift/require-convex-return-validator",
    file: "tooling/antidrift/src/__probe_convex_returns.ts",
    source: `
      import { query } from "./node_modules/convex/server.js";
      import { v } from "./node_modules/convex/values.js";
      export const missingReturns = query({
        args: { id: v.string() },
        handler: () => "ok",
      });
      export const anyReturns = query({
        args: { id: v.string() },
        returns: v.any(),
        handler: () => "ok",
      });
      export const validReturns = query({
        args: { id: v.string() },
        returns: v.string(),
        handler: () => "ok",
      });
    `,
    expectedCount: 2,
  },
  {
    name: "no-nullable-positional-tuple (flags tuple with 2+ nullish slots while single-nullish and non-nullish tuples stay clean)",
    rule: "antidrift/no-nullable-positional-tuple",
    file: "tooling/antidrift/src/__probe_nullable_tuple.ts",
    source: `
      export type BadPair = [string | null, number | undefined];
      export type CleanPair = [string, number];
      export type SingleNullSlot = [string | null, number];
    `,
    expectedCount: 1,
  },
  {
    name: "no-explicit-type-arguments-on-owned-api (flags explicit type arguments on useSWR with typed fetcher while inferred call stays clean)",
    rule: "antidrift/no-explicit-type-arguments-on-owned-api",
    file: "tooling/antidrift/src/__probe_owned_api_type_args.ts",
    source: `
      import { useSWR } from "./node_modules/swr/index.js";
      const fetchUser = async (key: string): Promise<{ id: string }> => ({ id: key });
      export function useUserExplicit(id: string) {
        return useSWR<{ id: string }>(id, fetchUser);
      }
      export function useUserInferred(id: string) {
        return useSWR(id, fetchUser);
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-appeasement-erasure (flags closed Record annotation on case table and unknown widening on known object while satisfies stays clean)",
    rule: "antidrift/no-appeasement-erasure",
    file: "tooling/antidrift/src/__probe_appeasement_erasure.ts",
    source: `
      type Mode = "fast" | "slow";
      export const BAD_TABLE: Record<Mode, number> = { fast: 1, slow: 2 };
      export const BAD_UNKNOWN: unknown = { id: "1" };
      export const GOOD_TABLE = { fast: 1, slow: 2 } satisfies Record<Mode, number>;
    `,
    expectedCount: 2,
  },
  {
    name: "no-redundant-type-predicate (flags callback typeof predicate inferred by TS while unannotated callback stays clean)",
    rule: "antidrift/no-redundant-type-predicate",
    file: "tooling/antidrift/src/__probe_redundant_predicate.ts",
    source: `
      export function filterStrings(items: Array<string | number>) {
        const redundant = items.filter((item): item is string => typeof item === "string");
        const clean = items.filter((item) => typeof item === "string");
        return redundant.length + clean.length;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-underchecked-type-predicate (flags broad unknown predicate that omits required target properties)",
    rule: "antidrift/no-underchecked-type-predicate",
    file: "tooling/antidrift/src/__probe_underchecked_predicate.ts",
    source: `
      export interface AccountContract { id: string; role: string }
      export function isUndercheckedAccount(val: unknown): val is AccountContract {
        return typeof val === "object" && val !== null && "id" in val;
      }
      export function isCheckedAccount(val: unknown): val is AccountContract {
        return typeof val === "object" && val !== null && "id" in val && "role" in val;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-unresolved-dependency-types (flags unresolvable subpath on installed dependency while root import stays clean)",
    rule: "antidrift/no-unresolved-dependency-types",
    file: "tooling/antidrift/src/__probe_unresolved_dep.ts",
    source: `
      import { z } from "zod";
      import { missing } from "zod/nonexistent-subpath-for-probe";
      export const out = String(Boolean(z)) + String(Boolean(missing));
    `,
    expectedCount: 1,
  },
  {
    name: "no-pass-through-parameters (flags pure forwarding hop while local-variable guard join requireOwner(session, todo) stays clean)",
    rule: "antidrift/no-pass-through-parameters",
    file: "tooling/antidrift/src/__probe_passthrough_params.ts",
    source: `
      function writeAudit(actor: string, targetId: string) {
        return \`\${actor}:\${targetId}\`;
      }
      export function forwardAudit(actor: string, targetId: string) {
        return writeAudit(actor, targetId);
      }
      declare function getTodo(id: string): { id: string; ownerId: string };
      declare function requireOwner(session: { userId: string }, todo: { id: string; ownerId: string }): void;
      export function handleRoute(session: { userId: string }, id: string) {
        const todo = getTodo(id);
        requireOwner(session, todo);
        return todo;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-identity-schema-transform (flags Valibot v.pipe(schema, v.transform((x) => x)) identity transform)",
    rule: "antidrift/no-identity-schema-transform",
    file: "tooling/antidrift/src/__probe_valibot_identity.ts",
    source: `
      import { v } from "./node_modules/valibot/index.js";
      export const badPipe = v.pipe(v.string(), v.transform((val) => val));
      export const goodPipe = v.pipe(v.string(), v.transform((val) => ({ wrapped: val })));
    `,
    expectedCount: 1,
  },
  {
    name: "no-contract-appeasement-projection (sumToProductErasure allows whole-variant spread while flagging collapsed bag)",
    rule: "antidrift/no-contract-appeasement-projection",
    file: "tooling/antidrift/src/__probe_sum_erasure_spread.ts",
    source: `
      type Outcome = { _tag: "Success"; value: string } | { _tag: "Failure"; reason: string };
      export function preserveViaSpread(outcome: Outcome) {
        return outcome._tag === "Success" ? { ...outcome, ok: true } : { ...outcome, ok: false };
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-query-join-or-tree-reshape (flags nested .find equijoin inside JSX .map callback)",
    rule: "antidrift/no-query-join-or-tree-reshape",
    file: "tooling/antidrift/src/__probe_jsx_map_equijoin.tsx",
    source: `
      type Item = { id: string; groupId: string };
      type Group = { id: string; title: string };
      export function GroupList({ items, groups }: { items: Item[]; groups: Group[] }) {
        return (
          <ul>
            {items.map((item) => (
              <li key={item.id}>{groups.find((group) => group.id === item.groupId)?.title}</li>
            ))}
          </ul>
        );
      }
    `,
    expectedCount: 1,
  },
];

const sharedHelperFiles = buildSharedHelperFiles(repoRoot, resolve);

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

const coveredRuleIds = new Set([
  ...batchInputs.map((entry) => entry.rule),
  ...headlessProbes.map((probe) => probe.rule),
  "antidrift/no-sql-string-concat",
]);
for (const registeredRule of registeredRules) {
  assert.ok(
    coveredRuleIds.has(registeredRule),
    `Expected registered rule '${registeredRule}' to have smoke coverage in rust-parity.mjs`
  );
}

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
    '[package]\nname = "antidrift-kernel"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(kernelSrc, "lib.rs"),
    "pub mod boundary;\npub mod provenance;\n"
  );
  writeFileSync(
    join(kernelSrc, "boundary.rs"),
    "pub struct BoundaryItem;\npub struct WindowBounds { pub x: i32, pub y: i32, pub width: u32 }\npub fn load_raw_manifest() -> serde_json::Value { serde_json::Value::Null }\n"
  );
  writeFileSync(
    join(kernelSrc, "provenance.rs"),
    [
      "use crate::{ boundary::BoundaryItem, boundary::load_raw_manifest };",
      "use serde::Deserialize;",
      "use std::collections::HashMap;",
      "// forbidden inline comment",
      "pub struct FrameBounds { pub x: i32, pub y: i32, pub width: u32 }",
      "#[derive(Deserialize)]",
      "pub struct LooseConfig { pub kind: String, pub exclude_files: Vec<String>, pub seen: HashMap<String, bool>, pub item: Option<BoundaryItem> }",
      "pub fn decode_rule_options(name: &str) -> Result<usize, String> { Ok(name.len()) }",
      "pub fn legacy_adapter(input: &str) -> Result<usize, String> {",
      "    decode_rule_options(input)?;",
      '    input.parse::<usize>().map_err(|_| "parse failed".to_string())',
      "}",
      "pub fn hop_wrapper(input: &str) -> Result<usize, String> { let _ = input; legacy_adapter(input) }",
      "pub struct Holder { pub ident: String }",
      "pub struct ProjectMeta { pub project_id: String, pub project_key: String }",
      "pub struct StatusEnvelope { pub ok: bool, pub count: usize }",
      "pub struct OutcomeBag { pub ok: bool, pub count: usize, pub error: Option<String> }",
      "pub fn make_envelope_a(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n } }",
      "pub fn make_envelope_b(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n + 1 } }",
      "pub fn compare_ident(h: &Holder, val: &serde_json::Value) -> bool {",
      '    let _ = val["k"].as_str();',
      "    let from_helper = load_raw_manifest();",
      '    let _ = from_helper.get("nested").and_then(|v| v.as_u64());',
      '    let _ = h.ident.to_string() == "foo";',
      '    if let Ok(text) = std::fs::read_to_string("foo.txt") { let _ = text.len(); }',
      '    let _ = std::fs::read_to_string("bar.txt").unwrap_or_default();',
      '    let bins = ["dist/bin/tool", "target/release/tool", "target/debug/tool"];',
      "    let _ = bins.iter().find(|p| std::path::Path::new(p).exists());",
      "    let raw_json = serde_json::to_string(&h.ident).unwrap();",
      "    let _ = serde_json::from_str::<LooseConfig>(&raw_json);",
      "    let _ = h.ident.to_string().parse::<u32>();",
      "    let _ = serde_json::from_str::<LooseConfig>(&h.ident).ok();",
      "    match legacy_adapter(&h.ident) { Ok(_) => true, Err(_) => false }",
      "}",
      "pub async fn bad_async_sleep(err: &str, xs: &[Holder], ys: &[Holder]) -> OutcomeBag {",
      "    std::thread::sleep(std::time::Duration::from_millis(10));",
      '    let _ = err.to_string().contains("not found");',
      "    let _ = xs.iter().map(|x| ys.iter().find(|y| y.ident == x.ident)).count();",
      "    let cloned = Holder { ident: xs[0].ident.clone() };",
      "    let _ = cloned.ident.len();",
      "    match legacy_adapter(err) { Ok(v) => OutcomeBag { ok: true, count: v, error: None }, Err(e) => OutcomeBag { ok: false, count: 0, error: Some(e) } }",
      "}",
      "pub async fn serial_reads(h: &Holder) -> usize {",
      "    let first = read_one(h).await;",
      "    let second = read_two(h).await;",
      "    let third = read_three(h).await;",
      "    first + second + third",
      "}",
      "async fn read_one(h: &Holder) -> usize { h.ident.len() }",
      "async fn read_two(h: &Holder) -> usize { h.ident.len() + 1 }",
      "async fn read_three(h: &Holder) -> usize { h.ident.len() + 2 }",
      "pub fn branch_bag(flag: bool, h: &Holder) -> OutcomeBag {",
      "    if flag { OutcomeBag { ok: true, count: 1, error: None } } else { OutcomeBag { ok: false, count: 0, error: Some(h.ident.clone()) } }",
      "}",
      "pub fn sniff_text(text: &str) -> Option<LooseConfig> {",
      "    serde_json::from_str(text).ok()",
      "}",
      "#[cfg(all(test))]\nmod inline_tests {}",
      "",
    ].join("\n")
  );
  writeFileSync(join(kernelSrc, "orphan_file.rs"), "pub fn unused() {}\n");
  writeFileSync(join(kernelSrc, "bad_helpers.rs"), "pub fn helper() {}\n");
  const rulesSrc = join(tempWorkspace, "crates/antidrift-rules/src");
  mkdirSync(rulesSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-rules/Cargo.toml"),
    '[package]\nname = "antidrift-rules"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(rulesSrc, "lib.rs"),
    "pub struct ScopelessRule;\npub trait Rule {}\nimpl Rule for ScopelessRule {}\n"
  );

  const rustSubcmd = spawnSync(binaryPath, ["rust", "--json", tempWorkspace], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    rustSubcmd.status,
    1,
    `Expected antidrift-linter rust to exit 1 on violations, got ${rustSubcmd.status}: ${rustSubcmd.stderr}`
  );
  const rustDiags = JSON.parse(String(rustSubcmd.stdout ?? ""));
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
    "rust/no-silent-result-discard",
    "rust/require-rule-scope",
    "rust/no-structural-type-fork",
    "rust/no-value-roundtrip",
    "rust/no-decode-to-option",
    "rust/no-constant-return-field",
    "rust/no-redundant-owner-prefix",
    "rust/no-hollow-module",
    "rust/no-blocking-in-async",
    "rust/no-query-join-or-tree-reshape",
    "rust/no-contract-appeasement-projection",
  ]) {
    assert.ok(
      reportedRuleIds.has(expectedRuleId),
      `Expected antidrift-linter rust to report ${expectedRuleId}, got ${JSON.stringify(rustDiags)}`
    );
  }
  for (const expectedMessage of [
    'collapsed into "" via fallback',
    "Do not serialize and deserialize the same value",
    "wall-clock sleep 'std::thread::sleep' inside an async context",
    "Three or more independent reads are awaited one after another",
    "Nested '.find(...)' performs an O(N*M)",
    "spans multiple build output tiers",
    "Untyped config probe '.as_u64()'",
  ]) {
    assert.equal(
      rustDiags.filter((diag) => String(diag.message).includes(expectedMessage))
        .length,
      1,
      `Expected antidrift-linter rust diagnostics to include '${expectedMessage}', got ${JSON.stringify(rustDiags)}`
    );
  }
  assert.equal(
    rustDiags.filter((diag) =>
      String(diag.message).startsWith("Success and failure arms")
    ).length,
    2,
    `Expected the match and if/else outcome bags to each report once, got ${JSON.stringify(rustDiags)}`
  );
  assert.equal(
    rustDiags.filter((diag) => diag.ruleId === "rust/no-decode-to-option")
      .length,
    1,
    `Expected one decode-to-option report for the .ok() discard and none for the sniffed text input, got ${JSON.stringify(rustDiags)}`
  );
  const singleRsRun = spawnSync(
    binaryPath,
    ["rust", "crates/antidrift-linter/src/main.rs"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );
  assert.equal(
    singleRsRun.status,
    0,
    `Expected single-file rust target to exit 0, got ${singleRsRun.status}: ${singleRsRun.stderr}`
  );
  const nearCapFile = join(tempWorkspace, "near_cap.rs");
  writeFileSync(
    nearCapFile,
    Array.from(
      { length: 430 },
      (_, idx) => `pub const C_${idx}: usize = ${idx};`
    ).join("\n") + "\n"
  );
  const nearCapRun = spawnSync(binaryPath, ["rust", "--json", nearCapFile], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    nearCapRun.status,
    0,
    `Expected near-cap warning to exit 0 without --deny-warnings, got ${nearCapRun.status}`
  );
  const nearCapDiags = JSON.parse(String(nearCapRun.stdout ?? ""));
  assert.equal(
    nearCapDiags.filter(
      (diag) =>
        diag.ruleId === "rust/max-file-lines" && diag.severity === "warn"
    ).length,
    1,
    `Expected 1 warn rust/max-file-lines diagnostic, got ${JSON.stringify(nearCapDiags)}`
  );
  const nearCapDenyRun = spawnSync(
    binaryPath,
    ["rust", "--json", "--deny-warnings", nearCapFile],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );
  assert.equal(
    nearCapDenyRun.status,
    1,
    `Expected near-cap warning to exit 1 with --deny-warnings, got ${nearCapDenyRun.status}`
  );
  const overCapFile = join(tempWorkspace, "over_cap.rs");
  writeFileSync(
    overCapFile,
    Array.from(
      { length: 505 },
      (_, idx) => `pub const D_${idx}: usize = ${idx};`
    ).join("\n") + "\n"
  );
  const overCapRun = spawnSync(binaryPath, ["rust", "--json", overCapFile], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    overCapRun.status,
    1,
    `Expected over-cap error to exit 1, got ${overCapRun.status}`
  );
  const overCapDiags = JSON.parse(String(overCapRun.stdout ?? ""));
  assert.equal(
    overCapDiags.filter(
      (diag) =>
        diag.ruleId === "rust/max-file-lines" && diag.severity === "error"
    ).length,
    1,
    `Expected 1 error rust/max-file-lines diagnostic, got ${JSON.stringify(overCapDiags)}`
  );
} finally {
  rmSync(tempWorkspace, { recursive: true, force: true });
}

const projectRootWorkspace = mkdtempSync(
  join(tmpdir(), "antidrift-project-root-")
);
try {
  const hopFindingsUnder = (parentDir) => {
    const repoDir = join(projectRootWorkspace, parentDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler" }, "include": ["src"] }\n'
    );
    writeFileSync(
      join(repoDir, "package.json"),
      '{ "name": "project-root-probe", "version": "0.0.0", "type": "module", "private": true }\n'
    );
    writeFileSync(
      join(repoDir, "src/owner.ts"),
      "export function loadAccount(accountId: string): string {\n  return accountId.toUpperCase();\n}\n"
    );
    writeFileSync(
      join(repoDir, "src/hop.ts"),
      'import { loadAccount } from "./owner";\n\nfunction fetchAccount(accountId: string): string {\n  return loadAccount(accountId);\n}\n\nexport function render(accountId: string): string {\n  return fetchAccount(accountId);\n}\n'
    );
    const run = spawnSync(binaryPath, ["--format", "json", "src"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    return JSON.parse(String(run.stdout ?? "[]"))
      .flatMap((entry) =>
        entry.messages.map(
          (message) =>
            `${entry.filePath.split("/").pop()}:${message.line} ${message.ruleId}`
        )
      )
      .sort();
  };
  const plainFindings = hopFindingsUnder("plain");
  assert.deepEqual(plainFindings, [
    "hop.ts:3 antidrift/no-pass-through-parameters",
    "hop.ts:3 antidrift/no-wrapping-functions",
    "hop.ts:7 antidrift/no-pass-through-parameters",
    "owner.ts:1 antidrift/no-wrapping-functions",
  ]);
  for (const ancestor of ["build", "dist", "gen", "tests", "fixtures"]) {
    assert.deepEqual(
      hopFindingsUnder(ancestor),
      plainFindings,
      `A repository under a '${ancestor}' directory must lint like any other: file roles come from the path below the working directory`
    );
  }
} finally {
  rmSync(projectRootWorkspace, { recursive: true, force: true });
}

const deriveWorkspace = mkdtempSync(join(tmpdir(), "antidrift-derive-"));
try {
  const sampleRoot = resolve(repoRoot, "apps/shape-sample");
  const copyRoot = join(deriveWorkspace, "apps/shape-sample");
  cpSync(
    resolve(repoRoot, "tsconfig.base.json"),
    join(deriveWorkspace, "tsconfig.base.json")
  );
  symlinkSync(
    resolve(repoRoot, "node_modules"),
    join(deriveWorkspace, "node_modules"),
    "dir"
  );
  cpSync(sampleRoot, copyRoot, {
    recursive: true,
    filter: (source) =>
      !source.includes("node_modules") && !source.includes("/src/generated"),
  });
  const generatedFiles = [
    "wire.ts",
    "client.ts",
    "server.ts",
    "manifest.json",
    "derive-report.json",
  ];
  const cleanRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    cleanRun.status,
    0,
    `derive failed on the clean sample: ${cleanRun.stdout}${cleanRun.stderr}`
  );
  for (const name of generatedFiles) {
    assert.equal(
      readFileSync(join(copyRoot, "src/generated", name), "utf8"),
      readFileSync(join(sampleRoot, "src/generated", name), "utf8"),
      `apps/shape-sample/src/generated/${name} is stale; run antidrift-linter derive apps/shape-sample`
    );
  }
  const plantedViolations = {
    "src/methods/callbacky.ts":
      'import type { Session } from "../shared/session";\n\nexport async function callbacky(input: { label: string; onDone: () => void }, session: Session): Promise<string> {\n  input.onDone();\n  return Promise.resolve(session.userId);\n}\n',
    "src/methods/renamed.ts":
      'export async function somethingElse(): Promise<string> {\n  return Promise.resolve("renamed");\n}\n',
    "src/methods/syncMethod.ts":
      "export function syncMethod(label: string): string {\n  return label.toUpperCase();\n}\n",
    "src/methods/voidResult.ts":
      "export async function voidResult(): Promise<void> {\n  await Promise.resolve();\n}\n",
    "src/methods/optionalArg.ts":
      "export async function optionalArg(todoId: string, note?: string): Promise<string> {\n  return Promise.resolve(note ?? todoId);\n}\n",
    "src/routes/lists/route.ts":
      "export function GET(): Response {\n  return Response.json([]);\n}\n",
    "src/shared/asyncShared.ts":
      "export async function asyncShared(): Promise<number> {\n  return Promise.resolve(1);\n}\n",
    "src/client/leaky.ts":
      'import { listTodos } from "../server/store";\n\nexport function leak(): Promise<number> {\n  return listTodos("any").then((todos) => todos.length);\n}\n',
  };
  for (const [file, source] of Object.entries(plantedViolations)) {
    mkdirSync(dirname(join(copyRoot, file)), { recursive: true });
    writeFileSync(join(copyRoot, file), source);
  }
  const plantedRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    plantedRun.status,
    1,
    `derive must exit 1 on violations: ${plantedRun.stdout}${plantedRun.stderr}`
  );
  const plantedReport = JSON.parse(
    readFileSync(join(copyRoot, "src/generated/derive-report.json"), "utf8")
  );
  assert.deepEqual(
    plantedReport.diagnostics
      .map((diagnostic) => `${diagnostic.file} ${diagnostic.rule}`)
      .sort(),
    [
      "client/leaky.ts client-reaches-server",
      "methods/callbacky.ts method-param-not-wire",
      "methods/optionalArg.ts method-param-not-wire",
      "methods/renamed.ts method-export-name",
      "methods/syncMethod.ts method-must-be-async",
      "methods/voidResult.ts method-result-not-wire",
      "routes/lists/route.ts route-must-be-async",
      "shared/asyncShared.ts shared-must-be-sync",
    ]
  );
  for (const name of ["wire.ts", "client.ts", "server.ts"]) {
    assert.equal(
      readFileSync(join(copyRoot, "src/generated", name), "utf8"),
      readFileSync(join(sampleRoot, "src/generated", name), "utf8"),
      `planted violations must not change the derived ${name}`
    );
  }
} finally {
  rmSync(deriveWorkspace, { recursive: true, force: true });
}

const sampleSmoke = spawnSync(
  resolve(repoRoot, "node_modules/.bin/tsx"),
  ["apps/shape-sample/smoke/run.ts"],
  { cwd: repoRoot, encoding: "utf8" }
);
assert.equal(
  sampleSmoke.status,
  0,
  `shape-sample smoke failed: ${sampleSmoke.stdout}${sampleSmoke.stderr}`
);
assert.deepEqual(sampleSmoke.stdout.trim().split("\n"), [
  "ok   addTodo round-trips through derived decoders, Date included",
  "ok   malformed wire input fails at the boundary and names the field",
  "ok   completeTodo enforces ownership through the injected session",
  "ok   publication streams typed patches and stops when the client stops",
  "ok   publication withholds other owners' patches",
  "ok   client view model renders the optimistic patch, then the server's",
  "ok   route GET /todos/[id] serves JSON and refuses other owners",
  "7/7 steps passed",
]);

console.log(
  `✓ antidrift-linter Rust smoke passed (${registeredRules.size} rules registered, ${batchResults.length} portable batch cases + ${headlessProbes.length + 2} native tsrslint headless probes + failure-path, project-root, derive & rust linter smokes verified)`
);
