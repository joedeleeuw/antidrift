# no-underchecked-type-predicate Investigation

## Status

Implemented as `antidrift/no-underchecked-type-predicate`, enabled at error in the ESLint config (directive G2). A literal tag proves a variant, and so its payload, only when the value it is read from is already a closed union; read from raw `any`/`unknown`/open-record input, or through a type assertion, the predicate must also check the asserted payload fields. On the 70 local roots of the October 2026 rules review it reports 9 findings in 4 repositories with resolved dependencies, 8 true positives, plus 1 true positive in mrp (89%, every repository at or above 80%). See [Tag checks on raw input](#tag-checks-on-raw-input).

Current XAI default-branch evidence adds five tag-only predicate findings across `src/porcelain.ts` and `src/stream.ts`. `APIError.is` is a clean nominal-brand control: its `BRAND in err` check and the asserted class's `[BRAND]` property resolve to the same symbol. Arbitrary string `in` checks and capability probes are not nominal-brand proof.

## Scope

Detect functions that claim `x is T` or `asserts x is T` while only performing weak runtime checks on broad input such as `unknown`, `any`, `object`, or `Record<string, unknown>`.

This is not a general boolean-predicate rule. Ordinary predicates and valid discriminated-union guards stay out of scope.

The implemented v1 reports only when all of these are true:

1. The predicate input is broad (`any`, `unknown`, `object`, `{}`, or `Record<string, unknown>`), and its declared type resolves.
2. The asserted target is an object contract, or a union of object contracts, with at least one required non-method property.
3. The body does not delegate to a validator/schema.
4. The body checks fewer than all required asserted target properties.

## Tag checks on raw input

The September 2026 evidence change counted a literal equality on a discriminant property of the asserted type as proof. That is sound for a closed union: `item.kind === "text"` on an `Item` proves the `TextItem` payload because TypeScript already knows every variant. On raw input it proves only the tag. Codex's October 2026 review found two missed true positives:

- `chatbiz-webapp/src/embed/protocol.ts:94-100`: `isEmbedMessage(data: unknown): data is EmbedMessage` checks `source` and that `type` is a string, through `data as { source?: unknown; type?: unknown }`. `{ source: "chatbiz-embed", type: "resize" }` passes as a resize message without its required `height`.
- `deep-seek/tools/server/webui/src/lib/stores/tools.svelte.ts:67-73`: `(t: unknown): t is OpenAIToolDefinition` checks `type === "function"` and `function.name`, but not the required `function.parameters`. The `llama.cpp-rocmfpx` fork carries the same guard.

Changes:

1. A literal equality counts as discriminant proof only when the value the tag is read from is not broad input to the TypeChecker, the tag is a unit or union-of-units property there, and the read does not pass through a type assertion (`(value as Tool).type`, or a local bound to `data as {...}`).
2. A union of object contracts is checked, not skipped: the required fields are those of the variants the body's literal tag comparisons (`===`, `!==`, `switch` cases) can still accept.
3. When the body reads into a required object field (`value.function.name`), that field's own required properties must be checked too.
4. A helper called with the predicate value and a literal key (`hasString(value, "text")`) checks that key.
5. A parameter whose declared type does not resolve (TypeScript's error type, e.g. a broken global re-export) is not raw input.

The other proof exemptions are `instanceof`, delegated type predicates (Effect `Schema.is`, `Predicate.isTagged`), schema validator delegation, `Reflect.get` reads, destructured field checks, and nominal brands whose computed property symbol matches the symbol used in the `in` check. Arbitrary string `in` checks and capability probes are not brand proof.

### Measurement

Corpus: the 70 local roots in `/tmp/rules-review/corpus-local.txt`, with cloud-rl-train `tasks/*/*`, `configs/eval-panel-qwen36.json` and `tasks/grader_process.py` excluded before parsing; 473 files containing a type predicate, 464 type-checked.

Dependencies matter for this rule: in a checkout without `node_modules` an unresolved import turns a callback's contextual type into `any`, which then reads as raw input. Precision was therefore measured on frozen-lockfile copies of chatbiz-webapp, fungible, sandcastle, codebase-atlas, paseo, homer-production and the deep-seek and llama.cpp-rocmfpx web UIs, plus the explicit-`unknown` finding in mrp.

| Version | Hits | Repositories | Top 5                                                              | Precision |
| ------- | ---: | -----------: | ------------------------------------------------------------------ | --------- |
| Before  |    2 |            1 | paseo 2                                                            | 1/2       |
| After   |   10 |            5 | paseo 6, chatbiz-webapp 1, deep-seek 1, llama.cpp-rocmfpx 1, mrp 1 | 9/10      |

After, true positives: `chatbiz-webapp src/embed/protocol.ts:94`, `deep-seek .../stores/tools.svelte.ts:67` and its rocmfpx fork, `mrp src/domain/notifications.ts:217` (tag-only check of a three-variant failure union whose payloads go unchecked), paseo `split-container.tsx:142,146` (drag data narrowed by `kind` without `paneId`/`tabId`), `snapshot-engine.ts:157` (`ok: false` never checked), `session-stubs.ts:120` (`"type" in m` claims the whole outbound-message union), `terminal-emulator.tsx:134` (`scrollback` and `cursor` unchecked). False positive: paseo `agent-response-loop.ts:108`, a `typeof value.safeParse === "function"` capability probe asserting `z.ZodType`.

Per repository: paseo 5/6, chatbiz-webapp 1/1, deep-seek 1/1, llama.cpp-rocmfpx 1/1, mrp 1/1. Before the change the two copies of the deep-seek UI also reported two `DatabaseMessageExtra` filters whose parameter type is the error type (the global re-export in `app.d.ts` does not resolve); the error-type exemption removed them.

The same scan without installed dependencies reports 25 findings in 11 repositories before (0 true positives: all 25 are `any` from unresolved imports) and 18 in 6 after (6 true positives). Lint the rule only on a program whose dependencies resolve.

## Ecosystem Check

Known adjacent rules:

- `@typescript-eslint/switch-exhaustiveness-check` covers exhaustive handling after discriminated-union narrowing.
- `@typescript-eslint/no-unnecessary-condition` can flag impossible or redundant conditions.
- `@typescript-eslint/no-redundant-type-constituents` catches useless union/intersection constituents.

These do not prove that a custom type predicate actually validates the asserted target type. No ecosystem replacement has been found. Keep the custom rule enabled at error with `stable: false` while known false-positive classes and independent replication remain open.

## Custom Solve

Use TypeChecker plus AST/control-flow evidence:

1. Find a return type predicate or assertion signature.
2. Resolve the asserted target type and required properties.
3. Treat object intersections as contracts when their constituents expose object properties; do not broaden the shared structural-type-fork `isObjectType` helper, which intentionally rejects intersections for a different reason.
4. Count decisive checks in the body: schema delegation, discriminant checks, `in` checks, member guards, array checks, and validator calls.
5. Flag only when broad input is laundered into a nontrivial object contract with no validator and insufficient decisive checks.

## Real Corpus Evidence

Former Chaski candidate, now clean:

- `src/frontend/bff/api/routers/retool/service-stop-router.ts` line 394: `z.custom<RetoolLineItemData>` uses `(value): value is RetoolLineItemData => value != null && typeof value === "object"`. The asserted type resolves as an optional-heavy intersection (`Partial<LineItemData> & { ... }`). This remains useful inventory, but it is not a blocking finding under the current required-property proof floor.

Chaski clean controls:

- `src/frontend/bff/shared/date.ts`: `isDateMessage` checks `year`, `month`, and `day`.
- `src/frontend/bff/api/schemas/powersync.ts`: discriminant predicates narrow already-typed unions by table/data shape.
- `src/frontend/monolithui/src/components/AccountDetails.tsx`: `isDateStruct` destructures `year`, `month`, and `day` from `Record<string, unknown>` before checking each primitive. This is a clean guard that protects the destructured-field-check edge.

Broad Chaski BFF inventory originally reported exactly one candidate across 177 files: the `RetoolLineItemData` predicate. The required-property narrowing demoted it from blocking evidence.

Codebase Atlas clean controls:

- `src/programs/persistenceCuration.ts`: `isTerrainLayoutAnchor` checks `q`, `r`, and `position` through a local alias before claiming the object type. This forced the rule to follow direct aliases when counting checked properties.
- `src/programs/repoComprehensionSurfaces.ts`: a primitive `value is string` predicate stays clean because this rule is limited to nontrivial object contracts.
- `src/needle/AtlasNeedleRenderer.ts`: `isMeshStandardMaterial` narrows a third-party material union with `emissive` and `roughness` probes. This is valid interop narrowing, not broad-input contract laundering.

Sudocode clean controls:

- `cli/src/integrations/plugin-loader.ts`: `isValidPlugin` narrows `unknown` to `IntegrationPlugin` after checking the plugin API surface fields.
- `frontend/src/components/workflows/CreateWorkflowDialog.tsx`: `isValidPersistedSettings` narrows `unknown` localStorage data after checking several persisted settings fields.
- `server/src/execution/output/coalesced-types.ts`: `isCoalescedUpdate` narrows a broad event to a union by discriminant. The union target stays out of the report path.

Former Opencode candidate, now clean:

- `packages/ui/src/components/basic-tool.tsx` line 19: `isTriggerTitle(val: any): val is TriggerTitle` checks object/null/title/Node before claiming `TriggerTitle`. Claude review found `title` is the only required field; optional-field sufficiency remains inventory/research rather than blocking proof.

Reproducible inventory:

```bash
pnpm policy:inventory-underchecked-predicate
```

Current result:

- 1,353 type-aware files checked.
- 64 type-predicate candidate files.
- 112 type-predicate signatures.
- 0 parser errors.
- 0 `antidrift/no-underchecked-type-predicate` findings.
- 0 drift repositories.
- 0 same-line overlaps with adjacent TypeScript ESLint unsafe rules.

This does not satisfy the old "second evaluable drift" blocker. The prior Chaski and Opencode findings are now clean controls for the stricter required-field proof floor.

## Known Risks

- Valid discriminated-union guards may only check one discriminant.
- Guards may delegate to a validator helper that needs provenance tracking.
- Optional-property counting can overstate what a runtime guard must check; optional-field sufficiency stays inventory/research unless a stronger proof exists.
- The validator delegation escape is name-shaped (`safeParse`, `validate`, `assert`, `check`, `isX`, `hasX`), so a trivial helper with a validator-looking name can hide a false negative.
- Incidental member reads can count as checked fields if they are not part of a real guard expression.

## Claude Advisory Review

Claude Opus 4.8 advisory review completed on June 8, 2026 (`reports/claude-rule-reviews/20260608-105341-type-predicate.md`). It read repo code through `Read`, `Grep`, and `Glob`; stderr was empty.

The review agreed:

- No supported ecosystem rule checks predicate-body sufficiency.
- The TypeChecker entry gates are real: broad input, asserted object target, intersection handling, and property count all need type services.
- The verdict layer is necessarily heuristic because runtime validation sufficiency cannot be proved generally.
- At the time, keep the rule `ready`, not stable; the June 15 review below supersedes that maturity call for optional-property cases.
- Do not promote until another real repository supplies an underchecked broad-input predicate drift case.
- Add or seek clean controls for destructuring, assertion signatures, and validator delegation names outside the current regex.

Claude Opus 4.8 advisory review on June 15, 2026 (`reports/claude-rule-review-no-underchecked-type-predicate-20260615.md`) challenged the promotion evidence:

- The Opencode case was only a one-file target, not an independent broad inventory.
- `TriggerTitle` has one required field; optional fields should not have been counted as required predicate proof.
- The rule should narrow required-property handling before promotion.
- After narrowing and broadening Opencode UI to `packages/ui/src/**/*.{ts,tsx}`, the inventory is parser-clean with 0 custom findings.

## Promotion Conditions

- Another real repository contains an under-checked `x is T` or `asserts x is T` drift case that misses required asserted fields. Current status: satisfied by XAI's five tag-only predicates. Stable promotion still needs review of the remaining false-positive classes and independent evidence.
- Another real repository contains clean validator-backed and discriminant-only controls. Codebase Atlas now supplies additional clean controls for alias-backed field checks, primitive predicates, and third-party union predicates.
- Claude Opus 4.8 review has read the narrowed rule code and corpus cases; rerun advisory review before promotion if new required-field drift appears.
