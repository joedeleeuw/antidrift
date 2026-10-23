# no-redundant-type-predicate Investigation

Status: `ready`, enabled at error in the ESLint config, with an autofix that deletes the annotation. Directive G2.

## Problem Statement

A callback states its own type predicate even though its body is one native check that TypeScript 5.5+ already turns into that predicate:

```ts
const texts = items.filter(
  (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
    item.kind === "assistant_message"
);
```

The annotation is an unchecked assertion. Today it agrees with the check; when either side is edited, TypeScript keeps trusting the annotation and no longer compares it to the check. With the annotation deleted, the predicate is inferred from the check and cannot drift from it.

## Signal

Reported when all of these hold, with types from the TypeChecker:

1. The function is an arrow or function expression passed as a call or `new` argument (a callback), not async or a generator, and the TypeScript in use is 5.5 or newer.
2. Its return type is `param is T` (not `asserts`, not `this is`) on a plain identifier parameter.
3. The body is a single returned check on that parameter: `x instanceof C`, `typeof x === "string"` (`number`, `bigint`, `boolean`, `symbol`, `undefined`), `x.tag === literal` / `x?.tag === literal`, or `x !== null` / `x !== undefined` / `x != null`.
4. TypeScript would infer a predicate from that check on the parameter's declared or contextual type: the check narrows the type to a strict subset, and the false branch excludes all of it. For a tag check the parameter must be a union whose every member has a unit-typed tag; a member whose tag could also be another value keeps the false branch open, so nothing is inferred. Generic classes and type-parameter inputs are skipped.
5. The narrowed type and `T` are mutually assignable, constituent by constituent. An asserted `any` never matches.

The autofix removes the return annotation and any import specifier whose only references sat inside it, so `noUnusedLocals` stays clean.

## Corpus Evidence

Measured on the 70 local roots of the October 2026 rules review.

| Run                                                                      | Hits | Repositories | Top 5                                                                                |
| ------------------------------------------------------------------------ | ---: | -----------: | ------------------------------------------------------------------------------------ |
| Wide sweep, 473 predicate files, dependencies as checked out             |  146 |           10 | paseo 103, a private app 24, another private app 7, fungible 3, ProRL-Agent-Server 2 |
| Frozen-lockfile copies (three private apps, fungible, sandcastle, paseo) |  177 |            6 | paseo 133, a private app 30, another private app 7, fungible 3, sandcastle 3         |

Check kinds among the fixed lines: null/undefined filters 89, literal tags 55, `typeof` 30; no `instanceof` callback qualified.

Autofix proof: the fix was applied to all 177 findings (100 files) in the six installed copies, then each repository's own type check ran before and after.

| Repository          | Command                          | Before        | After       |
| ------------------- | -------------------------------- | ------------- | ----------- |
| a private app       | `tsc --noEmit`                   | 0 errors      | 0 errors    |
| fungible            | `tsc --noEmit`                   | 0 errors      | 0 errors    |
| sandcastle          | `tsc --noEmit`                   | 0 errors      | 0 errors    |
| another private app | `pnpm -r typecheck`              | 0 errors      | 0 errors    |
| a third private app | `tsc --noEmit`                   | 20 (existing) | the same 20 |
| paseo               | `npm run typecheck --workspaces` | 19 (existing) | the same 19 |

The first pass left one new error in paseo: `acp-agent.ts` imported `AgentPromptContentBlock` only for the deleted annotation (TS6133). The fixer now removes such orphaned import specifiers; the second pass left the error sets identical.

Precision: 177/177 type-checked through the autofix across six repositories, plus a hand check of 32 findings (25 sampled from the copies and the 7 findings outside them in a fourth private app, ProRL-Agent-Server, joe-heavy-sleep and two llama.cpp forks, whose TypeScript versions are all 5.6 or newer).

The rule started at warn and moved to error: the type-checked precision held at 100% in all six repositories, above the promotion bar of 70% hand-checked precision in at least three repositories (80% until 2026-10-12).

## Ecosystem Check

`@typescript-eslint/no-unnecessary-type-assertion` covers `as` and `!`, not return-type predicates. `@typescript-eslint/explicit-function-return-type` pushes the other way. No maintained rule compares an explicit predicate with the predicate TypeScript 5.5 infers.

## Known Gaps

- Named predicate declarations are out of scope: an exported guard's annotation is part of its public signature.
- Multi-check bodies (`x !== null && x.kind === "a"`) are not modelled; TypeScript often infers them too.
- Tag checks need a union of unit-typed tags; `in` checks are not modelled.
