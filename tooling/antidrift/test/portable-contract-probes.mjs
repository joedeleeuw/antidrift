export const contractCoreHeadlessProbes = [
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
];
