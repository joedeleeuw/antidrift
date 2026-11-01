export const dataFlowProbes = [
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
];
