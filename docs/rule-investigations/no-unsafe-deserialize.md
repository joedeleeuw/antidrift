# `antidrift/no-unsafe-deserialize`

## Definition

Disallow `JSON.parse` when the argument's TypeScript type is `any` or `unknown`.

This is a TypeChecker rule, not a route-name or request-name heuristic. It does not try to prove taint. It enforces the narrower parse-at-edge pattern: broad values must be narrowed before parsing, and parsed shapes should be validated into contracts.

## Should Flag

```ts
declare const row: any;

const workflow = {
  source: JSON.parse(row.source),
  steps: JSON.parse(row.steps || "[]"),
};
```

Why: the database row is broad, so the parse result is being trusted without a typed boundary.

```ts
declare const payload: unknown;

const parsed = JSON.parse(payload);
```

Why: `unknown` must be narrowed before parsing.

## Should Not Flag

```ts
const contents = await fs.readFile(path, "utf8");
const value: unknown = JSON.parse(contents);
const project = parsePersistedProject(value);
```

Why: the parser consumes a typed string and the result is explicitly treated as `unknown` before validation.

```ts
if (typeof value === "string") {
  return JSON.parse(value);
}
```

Why: the input has been narrowed to string before parsing.

```ts
const parsed = schema.parse(JSON.parse(text));
```

Why: the parse consumes a typed string and immediately validates the resulting shape.

## Ecosystem

`@typescript-eslint/no-unsafe-argument` partially overlaps because it can catch some `any` arguments passed to `JSON.parse`. It is broader than this rule and does not carry the parse-at-edge replacement guidance. Antidrift owns the specific JSON boundary rule.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 199 parses `row.source` where the checker type is `any`.
- The same file also reports broad row parses at lines 201, 208, 793, 1010, 1012, 1019, and 1598.
- `/Users/sushi/code/cloudflare-agents/examples/assistant/src/server.ts` line 939 parses `r.config_json` where the checker type is `any`; the same file reports another broad config parse at line 1145.
- Additional Cloudflare Agents inventory found broad-message parses such as `experimental/gadgets-chat/src/client.tsx` lines 177 and 273 (`msg.event: any`) and `openai-sdk/streaming-chat/src/client.tsx` line 49 (`item.arguments: any`). These are inventory evidence, not yet separate gate cases.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-schema.ts` narrows or coerces values to string before parsing.
- `/Users/sushi/code/chaski/src/frontend/portal/components/ImpersonationWarning.tsx` parses typed localStorage strings.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` parses typed string row fields.
- `/Users/sushi/code/sudocode-main/server/src/routes/config.ts` parses file content strings.
- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` parses file contents into `unknown` and then validates with `parsePersistedProject`.
- `/Users/sushi/code/cloudflare-agents/packages/voice/src/text-stream.ts` parses a decoded `json: string` line and returns `Record<string, unknown>`.

Split TypeChecker inventory on June 4, 2026:

- Chaski BFF: 4 JSON.parse files, 0 findings.
- Chaski portal: 6 JSON.parse files, 0 findings.
- Chaski monolithui: 10 JSON.parse files, 0 findings in project-included files.
- Chaski crow-v2: 4 JSON.parse files, 0 findings.
- Codebase Atlas `src`: 6 JSON.parse files, 0 findings.
- Sudocode server: 57 JSON.parse files, 8 findings, all in `server/src/routes/workflows.ts`.
- Cloudflare Agents focused corpus: drift in `examples/assistant/src/server.ts`, clean control in `packages/voice/src/text-stream.ts`.
- Cloudflare Agents wider scan: at least 15 files reported before the scan stopped after enough dirty and clean candidates were collected.

## Known Narrowing Concern

Some Cloudflare WebSocket handlers guard `event.data` with `typeof event.data === "string"` before calling `JSON.parse(event.data)`, but the checker still reports the argument as `any` because DOM `MessageEvent.data` is `any`. Those cases are not being counted as stable-promotion evidence. Before stable promotion, decide whether the rule should add a small AST/control-flow exemption for direct `typeof <same expression> === "string"` guards over `any`.

## Promotion State

Status: `ready`, `stable: false`.

The rule is type-aware and now has two independent broad-input drift sources plus multiple clean controls. Stable promotion is still blocked by the guarded-`any` narrowing concern above, not by drift replication.
