export const reactCoreHeadlessProbes = [
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
