# no-underchecked-type-predicate Investigation

## Status

Implemented as `antidrift/no-underchecked-type-predicate`, currently default-off and under-proven.

## Scope

Detect functions that claim `x is T` or `asserts x is T` while only performing weak runtime checks on broad input such as `unknown`, `any`, `object`, or `Record<string, unknown>`.

This is not a general boolean-predicate rule. Ordinary predicates and valid discriminated-union guards stay out of scope.

The implemented v1 reports only when all of these are true:

1. The predicate input is broad (`any`, `unknown`, `object`, `{}`, or `Record<string, unknown>`).
2. The asserted target is a nontrivial object contract with at least two required properties.
3. The body does not delegate to a validator/schema.
4. The body checks fewer than two required asserted target properties.

## Ecosystem Check

Known adjacent rules:

- `@typescript-eslint/switch-exhaustiveness-check` covers exhaustive handling after discriminated-union narrowing.
- `@typescript-eslint/no-unnecessary-condition` can flag impossible or redundant conditions.
- `@typescript-eslint/no-redundant-type-constituents` catches useless union/intersection constituents.

These do not prove that a custom type predicate actually validates the asserted target type. No ecosystem replacement has been found; keep the custom rule default-off until corpus evidence proves the required-field drift threshold.

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

- Another real repository contains an under-checked `x is T` or `asserts x is T` drift case that misses required asserted fields. Current status: unsatisfied.
- Another real repository contains clean validator-backed and discriminant-only controls. Codebase Atlas now supplies additional clean controls for alias-backed field checks, primitive predicates, and third-party union predicates.
- Claude Opus 4.8 review has read the narrowed rule code and corpus cases; rerun advisory review before promotion if new required-field drift appears.
