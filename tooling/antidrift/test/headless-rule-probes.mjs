export const headlessRuleProbes = [
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
