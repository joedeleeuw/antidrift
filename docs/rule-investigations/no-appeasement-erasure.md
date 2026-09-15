# no-appeasement-erasure Investigation

Status: `ready`, shipped at error severity after the 2026-08-18 anti-slop catch-up.

## Problem Statement

A value with a known type is widened to `unknown`, and a contract is then re-established from it:

```ts
const result: unknown = auth.getAuthSnapshot(); // returns DesktopAuthSnapshot
return readAuthStateMethod.resultSchema.parse(result);
```

The erasure discards what the compiler proved and converts a compile-time contract into a runtime check inside the handler. The parse below looks like a boundary parse, but the boundary is manufactured: the value never left the process.

This is the upstream half of `antidrift/no-appeasement-cast`. That rule owns the `unknown -> named contract` direction and cannot see the step that produced the `unknown`.

## Signal

The current rule combines three signals:

1. The original TypeChecker branch reports a known initializer widened to `unknown` and then passed to a Zod or Effect decoder or cast back to a named contract.
2. Vendored `anti-slop/no-known-value-widening` reports syntactically established values assigned, returned, or asserted into broad targets.
3. Vendored `anti-slop/no-widen-then-assert` reports local bindings that discard known evidence and later assert a narrower contract.

Genuine raw values remain clean because the initializer has no known evidence to discard. Bare widening of an object, array, literal, function, class, or otherwise syntactically established value now reports even without later re-establishment.

Chained assertions are owned separately by `antidrift/no-unsafe-cast-chain`, now backed by the vendored `anti-slop/no-chained-type-assertions` implementation.

## Historical 2026-08-03 Investigation

The remaining measurements document the narrower TypeChecker-only implementation that preceded the anti-slop catch-up. Statements below that call bare widening clean, exclude empty literal widening, describe chained assertions as unmatched, or defer blocking severity are historical rather than current behavior.

## Why This Rule Is The Gate

Run against Murderbox desktop (`apps/desktop`, worktree branch `chore/conversation-callgraph-drift`), 38 files in `src`:

| Rule                                           | Findings |
| ---------------------------------------------- | -------- |
| `antidrift/no-parse-as-cast`                   | 6        |
| `antidrift/no-redundant-zod-parse`             | 0        |
| `antidrift/no-appeasement-cast`                | 0        |
| `antidrift/no-contract-appeasement-projection` | 0        |
| `antidrift/no-unsafe-deserialize`              | 0        |
| `antidrift/no-defensive-shape-probing`         | 0        |

`bridge.ts` alone holds 21 parse calls and `preload.ts` holds 18, yet five rules report nothing. The reason is mechanical: every masked site declares `unknown`, and each of those rules needs a type comparison that `unknown` defeats. The erasures are not one more smell alongside the others — they are why the others are silent.

Measured on 2026-08-03 (branch `desktop-erasure-remediation`): after removing the twelve `: unknown` annotations, `antidrift/no-redundant-zod-parse` went from **0 to 8 findings** — six in `bridge.ts`, two in `machine-workflows.ts` — with no rule changes on either side. The other four rules stayed at zero, which is honest: the erasures were masking redundant parses specifically, not those rules' defects. The gate claim is now counted, not expected: one erasure pattern was hiding eight findings from an already-shipped stable rule.

## Escape-Hatch Displacement

The anchor repo contains 2 `as unknown`, 0 `as any`, and 4 `as <T>` expressions across `src`, against 12 annotation erasures. `no-appeasement-cast` guards the cast form and reports zero here.

That is the general lesson: guarding one escape hatch moves the pressure to the unguarded one. A rule scoped to `as` would report nothing on this codebase while the same defect occurs 12 times through a type annotation. The `as unknown` branch of this rule is fixture-backed but has no real-corpus anchor yet, and should be kept anyway — it is the hatch that opens when the annotation form is closed.

## Real-Corpus Results

Murderbox desktop — **12 findings, 0 known false positives**:

- `src/bridge.ts:63, 100, 111, 124, 138, 151`
- `src/machine-workflows.ts:68, 78, 87`
- `scripts/authenticated-smoke.ts:225, 304`
- `scripts/smoke.ts:782`

Erased types include `boolean` (`bridge.ts:151`) and `string | null` (`bridge.ts:100`). Nobody defensively re-validates a boolean; the uniformity is what identifies this as an edge reflex rather than considered defensive validation.

Codebase Atlas — **0 findings across 34 files that declare `: unknown`**. Every one is a genuine boundary: `JSON.parse` results, caught errors typed `(cause: unknown)`, and generic probe parameters. This repo contributes the clean-control population.

Zero-finding repositories, after the two narrowings below. The zod column is what decides whether a zero means anything: the parse branch cannot fire in a repository that does not use zod.

| Repository        | zod-importing files | Candidate files | Findings | Counts as a control   |
| ----------------- | ------------------- | --------------- | -------- | --------------------- |
| Cloudflare Agents | 76                  | 371             | 0        | yes                   |
| Codebase Atlas    | 17                  | 34              | 0        | yes                   |
| Executor          | 5                   | 342             | 0        | no — 649 Effect files |
| PowerSync Service | 1                   | 9               | 0        | no                    |
| Agent Browser     | 0                   | 7               | 0        | no                    |

Chaski and LibreChat were skipped: no installed `node_modules`, so type-aware linting could not run.

Secondary validation (2026-08-03, first 60 non-test files of `packages/agents/src`): Cloudflare Agents' zero is **displacement, not cleanliness**. The same files report 18 `no-appeasement-cast`, 1 `no-contract-appeasement-projection`, and 1 `no-unsafe-deserialize` findings, plus 89 `as unknown as` double casts counted earlier. The codebase expresses unearned contracts through casts rather than erased annotations, so it is a genuine clean control for THIS rule's idiom while carrying the defect class through the neighbor idiom — the escape-hatch displacement pattern, observed from the other side.

Only the first two are evidence. Executor, PowerSync Service, and Agent Browser were counted as clean controls in an earlier pass and should not have been — a zero from a repository with five zod files says nothing about a zod-scoped rule.

## Unmatched Idioms

Executor is the useful negative result, for the opposite reason to the one first recorded. It contains **168 Effect `Schema.decode`/`decodeUnknown` call sites** and **53 `as unknown as T` double casts**. Both are laundering surfaces this rule cannot see:

- **Effect Schema.** Closed 2026-08-03: curried `Schema.decode*`/`decodeUnknown*` applications resolved to the `effect` package now count as re-establishment. Executor re-swept clean (0/342) with the branch active. Pre-built decoder bindings (`const dec = Schema.decodeUnknownSync(S); dec(value)`) remain a recorded false-negative slice.
- **`as unknown as T`.** Erasure and re-establishment collapse into one expression, so there is no declared binding for this rule to inspect and no `unknown`-typed operand for `no-appeasement-cast` to catch. It falls between the two antidrift rules — but not outside the stack. See below.

## Ecosystem Overlap

`typescript/no-unsafe-type-assertion` is enabled at error in `oxlint.config.mts` and covers more of this ground than the original entry claimed. Verified 2026-08-03 against a probe:

| Shape                                                         | `no-unsafe-type-assertion` | this rule        |
| ------------------------------------------------------------- | -------------------------- | ---------------- |
| `const result: unknown = getSnapshot(); result as Snapshot`   | reports                    | reports          |
| `value as unknown as T`                                       | reports                    | does not see it  |
| `value as unknown` (pure widening)                            | correctly silent           | correctly silent |
| `const result: unknown = getSnapshot(); schema.parse(result)` | silent                     | **reports**      |

Two conclusions. The **parse branch is the unique contribution** — no ecosystem rule asks whether a schema re-establishes a contract from an erased binding, and that branch is where all 12 Murderbox positives live. The **named-cast branch is ecosystem-covered** wherever `no-unsafe-type-assertion` is enabled; it is retained for consumers who do not enable it, but earns no independent value otherwise.

A custom `as unknown as T` rule should not be built. The 53 Executor and 89 Cloudflare Agents double casts are unreported in those repositories because they do not run this configuration, not because the stack lacks a rule.

**Scope caveat.** `no-unsafe-type-assertion` lives in this repository's own `oxlint.config.mts`, not in the shipped `oxlint-config`, which exports only `antidriftComplexityRules` and `createGovernanceOxlintConfig`. Keeping the strict TypeScript baseline local was a deliberate 0.5.0 decision. The practical effect is that "ecosystem-covered" holds here and not for consumers: Murderbox's own `oxlint.config.ts` carries none of those rules, so the named-cast branch of this rule is load-bearing there and redundant only inside this repository.

## Contract-Free Literal Narrowing

The Cloudflare Agents sweep reported one positive at `packages/agents/src/index.ts:963`:

```ts
const DEFAULT_STATE = {} as unknown;
// ...
private _state = DEFAULT_STATE as State;
if (this._state !== DEFAULT_STATE) { /* ... */ }
```

This is a sentinel for a generic `State` default with no concrete value, compared by identity and cast at each use. `{}` carries no contract, so widening it discards nothing — the rule's premise does not apply. Empty object and array literal initializers are now excluded, and the shape is a fixture control.

## `const` Narrowing

The first sweep reported one Executor positive at `packages/plugins/openapi/src/sdk/openapi-utils.ts:42`:

```ts
let current: unknown = this.doc;
for (const segment of segments) {
  if (typeof current !== "object" || current === null) return null;
  current = (current as Record<string, unknown>)[segment];
}
```

This is a traversal cursor, not a boundary value: it is reassigned each iteration, and the cast narrows after a `typeof` guard rather than manufacturing a contract. Restricting the rule to `const` bindings removes it and costs nothing — all 12 Murderbox positives are `const`. The shape is now a permanent clean control in `fixtures/programs/correct/appeasement-erasure-real-boundaries.ts`.

A sweep-harness error is worth recording so it is not repeated: the first Executor run reported 26 findings. Twenty-five were ESLint config noise — `Definition for rule '@typescript-eslint/no-explicit-any' was not found`, emitted for disable directives in files linted under an override config that does not load that plugin. Those messages carry a truthy `ruleId`, so a harness that counts `message.ruleId` truthiness inflates the count. Filter on the exact rule id.

## Scope Decision

Considered and rejected: reporting every erasure regardless of what follows. On the anchor repo the two forms are indistinguishable — all 12 erasures are followed by a parse — so the measurement does not favour either. Scoping to re-establishment was chosen for the defensible story ("the erasure bought a runtime check and nothing else") and because bare widening has a legitimate use.

Known false negative: an erased binding passed to a parameter with a named contract. That is the third re-establishment form and is not implemented; it needs callee signature resolution, and no corpus anchor demands it yet.

## Promotion Gate

1. A second repository supplies real positives. Six repositories have been swept; only Murderbox desktop has any. The corpus is also the wrong flavor — it is almost entirely first-party, which cannot separate one team's habit from an idiom the ecosystem produces. Widen to large, actively maintained, widely depended-on OSS TypeScript repositories that use Zod and contain deliberate `unknown`-narrowing helpers (`isRecord`, `isPlainObject`, `asRecord`).
2. Each zero-finding repository is secondary-validated: run the full family plus a survey of `as unknown as T` double casts and guard-helper idioms. A zero that coexists with visible laundering through an unmatched idiom is a missing branch, not a clean control.
3. The post-remediation family measurement is recorded, converting the gate claim from expected to counted.
4. DONE 2026-08-03: branch desktop-erasure-remediation, commits ba30be1f + 07c2cea0. Twelve erasures removed, then the twenty runtime validations they masked or accompanied (8 redundant re-parses, 6 parse-as-cast parameters, 6 IPC result re-parses). Desktop lint green at --max-warnings=0 on antidrift 0.6.0; all 183 tests pass unchanged. Boundary parses of unknown[] IPC input retained.
5. Known false positives stay at zero under the chosen scope.
