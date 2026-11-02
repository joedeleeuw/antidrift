export const boundaryCoreHeadlessProbes = [
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
    name: "unknown-input-must-be-decoded (call argument & assignment sinks; Readable.toWeb stream bridge stays clean while JSON.parse as T reports)",
    rule: "antidrift/unknown-input-must-be-decoded",
    source: `
      type Account = { id: string };
      interface NodeReadableStream<R = any> {
        pipeThrough<T>(transform: { writable: unknown; readable: NodeReadableStream<T> }): NodeReadableStream<T>;
      }
      declare const Readable: { toWeb(stream: unknown): NodeReadableStream<any> };
      declare function consume(account: Account): void;
      export async function load(response: Response, raw: string, stream: unknown) {
        consume(await response.json());
        const bridge = new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>);
        void bridge;
        return JSON.parse(raw) as Account;
      }
    `,
    expectedCount: 2,
  },
  {
    name: "no-unsafe-deserialize (alias-to-contract, JSON.stringify roundtrip, and unguarded persisted JSON.parse(String(readFileSync(...))) property access)",
    rule: "antidrift/no-unsafe-deserialize",
    source: `
      import { readFileSync } from "node:fs";
      type Account = { id: string };
      export function parseAccount(text: string, manifestPath: string) {
        const raw = JSON.parse(text);
        const account: Account = raw;
        const cloned = JSON.parse(JSON.stringify(account));
        const unguarded = JSON.parse(String(readFileSync(manifestPath)));
        const guarded = JSON.parse(String(readFileSync(manifestPath)));
        if (typeof guarded.version !== "string") {
          throw new Error("missing version");
        }
        return String(account.id) + String(cloned) + String(unguarded.version) + guarded.version;
      }
    `,
    expectedCount: 3,
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
    name: "unknown-input-must-be-decoded (flags statement decode when raw input flows to db.insert or return)",
    rule: "antidrift/unknown-input-must-be-decoded",
    source: `
      import { z } from "zod";
      const snapSchema = z.object({ id: z.string() });
      export async function saveTurn(db: { insert: (t: string, v: unknown) => Promise<void> }, input: { modelSnapshot: unknown }) {
        snapSchema.parse(input.modelSnapshot);
        await db.insert("turns", { modelSnapshot: input.modelSnapshot });
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-structural-type-fork (flags decoded blob property compared with sibling column and widened SDK chunk contract)",
    rule: "antidrift/no-structural-type-fork",
    source: `
      import { z } from "zod";
      export type UiChunk = { id: string; finishReason: string };
      export function verifyDoc(doc: { id: string; targetJson: string }) {
        const parsed = JSON.parse(doc.targetJson);
        return parsed.id === doc.id;
      }
    `,
    expectedCount: 2,
  },
];
