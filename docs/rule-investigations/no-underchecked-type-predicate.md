# no-underchecked-type-predicate Investigation

## Status

Implemented as `antidrift/no-underchecked-type-predicate`.

## Scope

Detect functions that claim `x is T` or `asserts x is T` while only performing weak runtime checks on broad input such as `unknown`, `any`, `object`, or `Record<string, unknown>`.

This is not a general boolean-predicate rule. Ordinary predicates and valid discriminated-union guards stay out of scope.

The implemented v1 reports only when all of these are true:

1. The predicate input is broad (`any`, `unknown`, `object`, `{}`, or `Record<string, unknown>`).
2. The asserted target is a nontrivial object contract with at least two properties.
3. The body does not delegate to a validator/schema.
4. The body checks fewer than two asserted target properties.

## Ecosystem Check

Known adjacent rules:

- `@typescript-eslint/switch-exhaustiveness-check` covers exhaustive handling after discriminated-union narrowing.
- `@typescript-eslint/no-unnecessary-condition` can flag impossible or redundant conditions.
- `@typescript-eslint/no-redundant-type-constituents` catches useless union/intersection constituents.

These do not prove that a custom type predicate actually validates the asserted target type. Keep this as `research` unless an ecosystem rule is found that checks predicate-body sufficiency.

## Custom Solve

Use TypeChecker plus AST/control-flow evidence:

1. Find a return type predicate or assertion signature.
2. Resolve the asserted target type and required properties.
3. Count decisive checks in the body: schema delegation, discriminant checks, `in` checks, member guards, array checks, and validator calls.
4. Flag only when broad input is laundered into a nontrivial object contract with no validator and insufficient decisive checks.

## Real Corpus Evidence

Chaski drift:

- `src/frontend/bff/api/routers/retool/service-stop-router.ts` line 394: `z.custom<RetoolLineItemData>` uses `(value): value is RetoolLineItemData => value != null && typeof value === "object"`.

Chaski clean controls:

- `src/frontend/bff/shared/date.ts`: `isDateMessage` checks `year`, `month`, and `day`.
- `src/frontend/bff/api/schemas/powersync.ts`: discriminant predicates narrow already-typed unions by table/data shape.

Broad Chaski BFF inventory reported exactly one finding across 177 files: the accepted `RetoolLineItemData` predicate.

Codebase Atlas clean controls:

- `src/programs/persistenceCuration.ts`: `isTerrainLayoutAnchor` checks `q`, `r`, and `position` through a local alias before claiming the object type. This forced the rule to follow direct aliases when counting checked properties.
- `src/programs/repoComprehensionSurfaces.ts`: a primitive `value is string` predicate stays clean because this rule is limited to nontrivial object contracts.
- `src/needle/AtlasNeedleRenderer.ts`: `isMeshStandardMaterial` narrows a third-party material union with `emissive` and `roughness` probes. This is valid interop narrowing, not broad-input contract laundering.

## Known Risks

- Valid discriminated-union guards may only check one discriminant.
- Guards may delegate to a validator helper that needs provenance tracking.
- Required-property counting can overstate what a runtime guard must check.

## Promotion Conditions

- Another real repository contains an under-checked `x is T` or `asserts x is T` drift case.
- Another real repository contains clean validator-backed and discriminant-only controls. Codebase Atlas now supplies additional clean controls for alias-backed field checks, primitive predicates, and third-party union predicates.
- Claude Opus 4.8 review has read the rule code, corpus cases, and this investigation doc.
