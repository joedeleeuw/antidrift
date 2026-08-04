# no-appeasement-erasure Investigation

Status: `under-proven`, default-off.

## Problem Statement

A value with a known type is widened to `unknown`, and a contract is then re-established from it:

```ts
const result: unknown = auth.getAuthSnapshot();      // returns DesktopAuthSnapshot
return readAuthStateMethod.resultSchema.parse(result);
```

The erasure discards what the compiler proved and converts a compile-time contract into a runtime check inside the handler. The parse below looks like a boundary parse, but the boundary is manufactured: the value never left the process.

This is the upstream half of `antidrift/no-appeasement-cast`. That rule owns the `unknown -> named contract` direction and cannot see the step that produced the `unknown`.

## Signal

Reported when all of these hold:

1. A variable is declared `unknown` — either `const x: unknown = expr` or `const x = expr as unknown`.
2. The TypeChecker's type for the initializer expression is neither `any` nor `unknown`.
3. Scope analysis finds a read reference of that binding that re-establishes a contract: the first argument of a Zod `parse`/`parseAsync`, or the operand of an `as` cast to a named type reference.

Bare widening with no downstream contract stays clean; widening to force exhaustive handling at a later narrowing point is legitimate.

## Why This Rule Is The Gate

Run against Murderbox desktop (`apps/desktop`, worktree branch `chore/conversation-callgraph-drift`), 38 files in `src`:

| Rule | Findings |
| --- | --- |
| `antidrift/no-parse-as-cast` | 6 |
| `antidrift/no-redundant-zod-parse` | 0 |
| `antidrift/no-appeasement-cast` | 0 |
| `antidrift/no-contract-appeasement-projection` | 0 |
| `antidrift/no-unsafe-deserialize` | 0 |
| `antidrift/no-defensive-shape-probing` | 0 |

`bridge.ts` alone holds 21 parse calls and `preload.ts` holds 18, yet five rules report nothing. The reason is mechanical: every masked site declares `unknown`, and each of those rules needs a type comparison that `unknown` defeats. The erasures are not one more smell alongside the others — they are why the others are silent.

How many of those rules regain reach after remediation is expected, not measured. That measurement is the next action.

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

| Repository | zod-importing files | Candidate files | Findings | Counts as a control |
| --- | --- | --- | --- | --- |
| Cloudflare Agents | 76 | 371 | 0 | yes |
| Codebase Atlas | 17 | 34 | 0 | yes |
| Executor | 5 | 342 | 0 | no — 649 Effect files |
| PowerSync Service | 1 | 9 | 0 | no |
| Agent Browser | 0 | 7 | 0 | no |

Chaski and LibreChat were skipped: no installed `node_modules`, so type-aware linting could not run.

Only the first two are evidence. Executor, PowerSync Service, and Agent Browser were counted as clean controls in an earlier pass and should not have been — a zero from a repository with five zod files says nothing about a zod-scoped rule.

## Unmatched Idioms

Executor is the useful negative result, for the opposite reason to the one first recorded. It contains **168 Effect `Schema.decode`/`decodeUnknown` call sites** and **53 `as unknown as T` double casts**. Both are laundering surfaces this rule cannot see:

- **Effect Schema.** `Schema.decodeUnknownSync(X)(value)` is the structural twin of `X.parse(value)`. An Effect codebase can carry the identical defect and report zero forever. This is the largest known coverage gap, and it means the corpus cannot be widened by adding Effect-based repositories until a decode branch exists.
- **`as unknown as T`.** Erasure and re-establishment collapse into one expression, so there is no declared binding for this rule to inspect and no `unknown`-typed operand for `no-appeasement-cast` to catch. It falls between the two rules.

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
4. A real remediation lands in Murderbox and demonstrably improves the code.
5. Known false positives stay at zero under the chosen scope.
