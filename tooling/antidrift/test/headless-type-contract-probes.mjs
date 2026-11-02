export const typeContractProbes = [
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
    name: "no-appeasement-erasure (flags closed Record annotation on case table, unknown widening on known object, and redundant unknown-narrowing helper calls while satisfies and value refinements stay clean)",
    rule: "antidrift/no-appeasement-erasure",
    file: "tooling/antidrift/src/__probe_appeasement_erasure.ts",
    source: `
      type Mode = "fast" | "slow";
      export const BAD_TABLE: Record<Mode, number> = { fast: 1, slow: 2 };
      export const BAD_UNKNOWN: unknown = { id: "1" };
      export const GOOD_TABLE = { fast: 1, slow: 2 } satisfies Record<Mode, number>;
      class AtomicFileWriteError extends Error {
        readonly committed = false;
      }
      function errorFromUnknown(raw: unknown): Error {
        if (raw instanceof Error) {
          return raw;
        }
        return new Error(String(raw));
      }
      function isFiniteNumber(raw: unknown): raw is number {
        return typeof raw === "number" && Number.isFinite(raw);
      }
      function finiteNumber(raw: unknown): number {
        if (typeof raw === "number" && Number.isFinite(raw)) {
          return raw;
        }
        return 0;
      }
      function finiteViaPredicate(raw: unknown): number {
        if (isFiniteNumber(raw)) return raw;
        throw new Error("not finite");
      }
      export function handleWriteFailure(cause: AtomicFileWriteError, genuineUnknown: unknown, count: number) {
        const direct = errorFromUnknown(cause);
        const explicitCast = errorFromUnknown(cause as unknown);
        const widened: unknown = cause;
        const viaVar = errorFromUnknown(widened);
        const fromUnknown = errorFromUnknown(genuineUnknown);
        const fromString = errorFromUnknown("boom");
        const refined = finiteNumber(count);
        const refinedViaPredicate = finiteViaPredicate(count);
        return [direct, explicitCast, viaVar, fromUnknown, fromString, refined, refinedViaPredicate];
      }
    `,
    expectedCount: 5,
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
    name: "no-pass-through-parameters (flags pure forwarding hop and member-forwarding hop while local-variable guard join stays clean)",
    rule: "antidrift/no-pass-through-parameters",
    file: "tooling/antidrift/src/__probe_passthrough_params.ts",
    source: `
      function writeAudit(actor: string, targetId: string) {
        return \`\${actor}:\${targetId}\`;
      }
      export function forwardAudit(actor: string, targetId: string) {
        return writeAudit(actor, targetId);
      }
      export function forwardBoundary(boundary: { error: string; retry: string }) {
        return writeAudit(boundary.error, boundary.retry);
      }
      declare function getTodo(id: string): { id: string; ownerId: string };
      declare function requireOwner(session: { userId: string }, todo: { id: string; ownerId: string }): void;
      export function handleRoute(session: { userId: string }, id: string) {
        const todo = getTodo(id);
        requireOwner(session, todo);
        return todo;
      }
    `,
    expectedCount: 3,
  },
  {
    name: "no-structural-type-fork (flags identical constant object literal repeated 3+ times)",
    rule: "antidrift/no-structural-type-fork",
    file: "tooling/antidrift/src/__probe_repeated_obj_lit.ts",
    source: `
      declare function spawn(cmd: string, opts: object): void;
      export function runAll() {
        spawn("a", { timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
        spawn("b", { timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
        spawn("c", { timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
      }
    `,
    expectedCount: 1,
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
