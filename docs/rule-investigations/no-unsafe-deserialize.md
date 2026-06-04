# `antidrift/no-unsafe-deserialize`

## Definition

Disallow `JSON.parse` when the argument's TypeScript type is `any` or `unknown`.

This is a TypeChecker rule, not a route-name or request-name heuristic. It does not try to prove taint. It enforces the narrower parse-at-edge pattern: broad values must be narrowed before parsing, and parsed shapes should be validated into contracts.

The rule uses one small AST/control-flow supplement: if an `any` expression is locally proven to be a string by a direct `typeof <expr> === "string"` branch, or by an early-exit guard such as `if (typeof <expr> !== "string") return`, the parse is treated as having crossed a string boundary. This matches the TypeScript/DOM declarations that make the problem awkward: `JSON.parse` takes `text: string`, while `MessageEvent<T = any>.data` defaults to `any`.

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
function onMessage(event: MessageEvent) {
  if (typeof event.data !== "string") return;
  return JSON.parse(event.data);
}
```

Why: DOM message payloads are checker-typed as `any`, but this local guard proves the parse input is a string. The parsed result still needs normal validation before being trusted as a domain shape.

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
- `/Users/sushi/code/cloudflare-agents/experimental/gadgets-chat/src/client.tsx` line 177 parses `msg.event` where `msg` came from a broad JSON parse; the same file reports the repeated shape at line 273.
- Additional Cloudflare Agents inventory found broad-message parses such as `openai-sdk/streaming-chat/src/client.tsx` line 49 (`item.arguments: any`). This is inventory evidence, not yet a separate gate case.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-schema.ts` narrows or coerces values to string before parsing.
- `/Users/sushi/code/chaski/src/frontend/portal/components/ImpersonationWarning.tsx` parses typed localStorage strings.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` parses typed string row fields.
- `/Users/sushi/code/sudocode-main/server/src/routes/config.ts` parses file content strings.
- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` parses file contents into `unknown` and then validates with `parsePersistedProject`.
- `/Users/sushi/code/cloudflare-agents/packages/voice/src/text-stream.ts` parses a decoded `json: string` line and returns `Record<string, unknown>`.
- `/Users/sushi/code/cloudflare-agents/voice-providers/twilio/src/index.ts` guards `event.data` with `typeof event.data === "string"` and an early-return `typeof event.data !== "string"` guard before parsing WebSocket messages.

Split TypeChecker inventory on June 4, 2026:

- Chaski BFF: 4 JSON.parse files, 0 findings.
- Chaski portal: 6 JSON.parse files, 0 findings.
- Chaski monolithui: 10 JSON.parse files, 0 findings in project-included files.
- Chaski crow-v2: 4 JSON.parse files, 0 findings.
- Codebase Atlas `src`: 6 JSON.parse files, 0 findings.
- Sudocode server: 57 JSON.parse files, 8 findings, all in `server/src/routes/workflows.ts`.
- Cloudflare Agents focused corpus: drift in `examples/assistant/src/server.ts` and `experimental/gadgets-chat/src/client.tsx`, clean controls in `packages/voice/src/text-stream.ts` and `voice-providers/twilio/src/index.ts`.
- Cloudflare Agents wider scan: at least 15 files reported before the scan stopped after enough dirty and clean candidates were collected.

## Guarded Any Boundary

Cloudflare WebSocket handlers proved the TypeChecker-only version was too blunt: `event.data` is typed as `any`, but code can still establish the exact runtime boundary `JSON.parse` needs by checking `typeof event.data === "string"`. The rule now exempts direct branch guards and early-return guards for the same expression. It does not exempt parsed subfields such as `JSON.parse(msg.event)` after `msg` came from an unvalidated broad parse.

## Promotion State

Status: `ready`, `stable: true`.

The rule is type-aware and now has two independent broad-input drift sources plus multiple clean controls. The guarded-`any` concern is resolved.

Claude Opus 4.8 advisory review completed on June 4, 2026 (`reports/claude-rule-review-no-unsafe-deserialize-20260604-145356.md`). It agreed the ecosystem overlap is partial, the strongest signal is TypeChecker plus a narrow local string-boundary exemption, and the real-corpus evidence is strong enough for promotion review. It recommended keeping `stable: false` until the remaining production concern was closed: if parser services are unavailable, type-aware rules could fail open. That concern is now closed by a shared rule-level guard: fully type-aware rules report a configuration error when enabled without TypeScript parser services.

Accepted stable limitations:

- Helper-based guards such as `if (!isString(event.data)) return` are not recognized.
- Aliased or computed parse calls such as `const { parse } = JSON` and `JSON["parse"](value)` are not matched.
- A local binding named `JSON` could be mistaken for the global JSON object.

Next slice: decide the test assertion scope for `antidrift/no-redundant-zod-parse`.
