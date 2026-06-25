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

`@typescript-eslint/no-unsafe-argument` is a real superset signal for the current
drift: when forced on against Sudocode, Codebase Atlas, and Opencode, it reports
the same broad-input `JSON.parse` lines that Antidrift reports. That means this
rule is not justified by unique detection.

The remaining Antidrift utility is scope, severity, and guidance. The upstream
rule is intentionally any-argument-wide, has no rule options, and the
TypeScript-ESLint docs warn that it can be hard to enable in codebases with many
existing unsafe areas. In this repository package slice, forcing
`@typescript-eslint/no-unsafe-argument` over `tooling/antidrift/src` and
`tooling/antidrift/test` produced 661 findings, while this rule stays limited to
the JSON parse boundary.

Keep this rule only as a narrow parse-at-edge gate. If a consumer already has
`@typescript-eslint/no-unsafe-argument` cleanly enabled, this rule is redundant
except for a more specific diagnostic message.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/sudocode-main/server/src/routes/workflows.ts` line 199 parses `row.source` where the checker type is `any`.
- The same file also reports broad row parses at lines 201, 208, 793, 1010, 1012, 1019, and 1598.
- `/Users/sushi/code/codebase-atlas/src/routes/atlas.city3d.tsx` lines 449 and 482 parse `MessageEvent.data` from EventSource handlers without first proving it is a string.
- `/Users/sushi/code/opencode/packages/console/resource/resource.cloudflare.ts` line 19 parses `env.SST_RESOURCE_App` without the string guard used by the adjacent resource branches.
- Opencode benchmark route parses remain real parse-output contract debt, but they are not current-rule drift because the rule is scoped to the parse input. Those rows belong to `antidrift/no-appeasement-cast`.
- Cloudflare Agents previously supplied drift in `examples/assistant/src/server.ts` and `experimental/gadgets-chat/src/client.tsx`, but the current checkout no longer evaluates those as blocking evidence: the assistant file changed substantially, and the Cloudflare tsconfigs extend `agents/tsconfig` without an install-resolvable package path in this external clone.
- Nested parsed-subfield drift splits into two rule owners. If the nested parse argument is still checker-typed `any` or `unknown`, this rule owns it. If the outer parse is immediately asserted into a named contract and that assertion makes the nested field appear typed, the root violation is `antidrift/no-appeasement-cast`.
- Additional Cloudflare Agents inventory found broad-message parses such as `openai-sdk/streaming-chat/src/client.tsx` line 49 (`item.arguments: any`). This is inventory evidence, not yet a separate gate case.
- Additional Cloudflare Agents inventory found production WebSocket parse-output assertions in `packages/ai-chat/src/ws-chat-transport.ts` (`JSON.parse(event.data as string) as OutgoingMessage` and `JSON.parse(data.body) as UIMessageChunk`). Those are tracked under `antidrift/no-appeasement-cast`, not this parse-input rule, and remain external-corpus `known-gap` until that checkout's `agents/tsconfig` dependency resolves.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/posthog-schema.ts` narrows or coerces values to string before parsing.
- `/Users/sushi/code/chaski/src/frontend/portal/components/ImpersonationWarning.tsx` parses typed localStorage strings.
- `/Users/sushi/code/sudocode-main/server/src/workflow/base-workflow-engine.ts` parses typed string row fields.
- `/Users/sushi/code/sudocode-main/server/src/routes/config.ts` parses file content strings.
- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` parses file contents into `unknown` and then validates with `parsePersistedProject`.
- `/Users/sushi/code/opencode/packages/console/resource/resource.cloudflare.ts` lines 11 and 16 guard `env` values with `typeof value === "string"` before parsing; the unguarded `App` branch at line 19 remains the matching drift.
- `/Users/sushi/code/cloudflare-agents/packages/voice/src/text-stream.ts` parses a decoded `json: string` line and returns `Record<string, unknown>`; this remains a useful clean-control shape, but the current external checkout is config-blocked for type-aware linting.
- `/Users/sushi/code/cloudflare-agents/voice-providers/twilio/src/index.ts` guards `event.data` with `typeof event.data === "string"` and an early-return `typeof event.data !== "string"` guard before parsing WebSocket messages; this also remains useful but config-blocked in the current external checkout.

Split TypeChecker inventory on June 4, 2026:

- Chaski BFF: 4 JSON.parse files, 0 findings.
- Chaski portal: 6 JSON.parse files, 0 findings.
- Chaski monolithui: 10 JSON.parse files, 0 findings in project-included files.
- Chaski crow-v2: 4 JSON.parse files, 0 findings.
- Codebase Atlas `src`: previously 6 JSON.parse files, 0 findings; current corpus adds EventSource parse-input drift in `src/routes/atlas.city3d.tsx`.
- Sudocode server: 57 JSON.parse files, 8 findings, all in `server/src/routes/workflows.ts`.
- Opencode console resource: 1 unguarded `env` parse-input finding plus adjacent guarded clean controls.
- Cloudflare Agents focused corpus: now recorded as known-gap rather than blocking evidence because the external example checkout cannot currently resolve `agents/tsconfig` for type-aware linting.
- Cloudflare Agents wider scan: at least 15 files reported before the scan stopped after enough dirty and clean candidates were collected.

## Guarded Any Boundary

Cloudflare WebSocket handlers proved the TypeChecker-only version was too blunt: `event.data` is typed as `any`, but code can still establish the exact runtime boundary `JSON.parse` needs by checking `typeof event.data === "string"`. The rule now exempts direct branch guards and early-return guards for the same expression. It does not exempt parsed subfields if the checker still sees the subfield as `any` or `unknown`.

## Promotion State

Status: `ready`, `stable: true`.

The rule is type-aware and has Sudocode, Codebase Atlas, and Opencode drift plus
multiple clean controls. The guarded-`any` concern is resolved, and the former
nested parsed-subfield blocker is reclassified: input-side broad nested parses
remain covered here, while output-side contract assertions belong to
`antidrift/no-appeasement-cast`.

The promotion argument is narrower after ecosystem recheck: this rule is a
low-noise parse-boundary specialization, not unique detection. It should stay
default-on only while the distributable config is unwilling to require the full
`@typescript-eslint/no-unsafe-argument` migration. If the package later adopts
that upstream rule broadly, this rule should be retired or demoted to a message
specialization.

Claude Opus 4.8 advisory review completed on June 4, 2026 (`reports/claude-rule-review-no-unsafe-deserialize-20260604-145356.md`). It agreed the strongest custom signal is TypeChecker plus a narrow local string-boundary exemption and recommended holding stable promotion until the remaining production concern was closed: if parser services are unavailable, type-aware rules could fail open. That concern is now closed by a shared rule-level guard: fully type-aware rules report a configuration error when enabled without TypeScript parser services. The current ecosystem re-audit is stricter than that review: upstream `@typescript-eslint/no-unsafe-argument` catches the present drift, so this rule's custom justification is lower-noise parse-boundary scope, not detection that ecosystem tools cannot express.

Accepted stable limitations:

- Helper-based guards such as `if (!isString(event.data)) return` are not recognized.
- Aliased or computed parse calls such as `const { parse } = JSON` and `JSON["parse"](value)` are not matched.
- A local binding named `JSON` could be mistaken for the global JSON object.

Next slice: monitor whether enabling `@typescript-eslint/no-unsafe-argument` is
practical for package consumers. Retire or demote this rule if ecosystem
coverage becomes acceptable without producing unrelated any-argument inventory.
