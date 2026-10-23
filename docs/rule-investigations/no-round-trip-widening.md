# no-round-trip-widening

## Concern

A value whose type the compiler already knows passes through a declared contract that forgets part of that type, and code downstream re-derives what was forgotten. The re-derivation is the evidence that the forgotten information was needed, so the contract does not fit its consumers. Widening without re-derivation is ordinary abstraction and does not report.

## Report condition

Each finding has three parts:

1. **A slot**, the declared contract `S`:
   - **Binding annotation**: `const properties: Record<string, unknown> = { ... }`, including element and property writes into a declared accumulator (`properties.metadata = ...`, `list.push(...)`).
   - **Cast to a broad type at an initializer**: `const record = part as Record<string, unknown>`, where the cast target is `any`, `unknown`, `object`, `{}` or a record of `unknown`/`any` values.
   - **Parameter** with an annotation, whose callers the program can see.
2. **The producers**, joined: the initializer or cast operand, later assignments and writes into the bound value, and for a parameter the arguments at every in-program call (a missing argument produces `undefined`, or the default).
3. **A recovery** on a value derived from the slot: an assertion to a narrower type, a type-predicate or assertion-function call, a `typeof`, `in`, `instanceof` or discriminant check, or an `any` value forwarded into a slot that demands a narrower type.

The rule reports when every producer already satisfies the recovery while the slot's own type does not: the recovery re-establishes `T'`, `T'` excludes something `S` admits, and no producer supplied it. Both comparisons are structural (`semantic-adapters/boundary/widening-cover.ts`): an interface counts as the record its properties fit, which plain assignability refuses because interfaces carry no implicit index signature. The relation otherwise stays at least as strict as TypeScript where TypeScript is right about run-time values: `{}` admits primitives, so it fits only targets that do too; `null` and `undefined` fit only targets that name them, also without `strictNullChecks`; and an all-optional target follows the weak-type rule, so a producer that shares none of its keys does not pass it vacuously. Producers are joined, so a dispatcher whose callers jointly pass every member, or an optional parameter that some callers omit, stays clean. A producer typed `any` or a type that did not resolve makes the slot undecided, never reported.

Derivation follows aliases, property and element access, destructuring, `for...of` and array callbacks, `await`, `??`, `||`, conditionals and object spread. A key a producer type does not declare reads as `unknown`, since object types are open. At the recovery, conditions that dominate it and probe the same slot (a discriminant comparison, `typeof`, `in`, a `switch` case, an early exit) filter the producer union and the slot's declared type the same way, so `part.type === "text" && typeof part.text === "string"` compares the text members' `text`, not every part's. A `case` clause is not a guard on its own recovery, and a condition on an element applies only to the same element: the same loop variable, callback parameter, binding element or element access, never `tokens[i]` to `tokens[i + 1]`. A producer whose values cannot reach the recovery, such as an empty array or members the guards exclude, passes vacuously, but at least one producer must reach it.

Not recoveries in this version: non-null assertions, `??`/`||` fallbacks, nullish comparisons and any check that only removes `null` or `undefined`, and a cast used only to write through it (`(config as Standard).type = "standard"`), which adds a member rather than re-deriving one; a write through a cast still counts as a producer. A recovery to a type built from a type parameter (`return result as T` after a generic merge) is deferred. Schema parses stay owned by `no-appeasement-erasure`.

## Exemptions

- A parameter of a type-predicate implementation (`value is T`) is the boundary that proves the type.
- A function referenced other than by a call (passed as a value, rendered as JSX, the default export, decorated, or overriding a library member) has callers the program cannot see, so its parameter edge is undecided.
- Parameters of anything exported from a package entry point are not reported; `publicSurface` decides the entry surface.
- An exported function whose name appears in a source file of its own package that the program does not hold (a test or script under another tsconfig, a directory the tsconfig leaves out) has callers out of view, so its parameter edge is undecided.
- Contracts declared in a third-party package and contracts that mention a type parameter are deferred.
- In test files only the binding and cast edges apply.

## Callers

Callers are looked up only for a parameter whose slot type a recovery narrows, and memoized per program. A call counts when its callee resolves to the function's symbol (through aliases and instantiated members), which needs no overload resolution; overloaded functions are undecided. For a method, a call through any receiver type that an instance of the class satisfies (a base class, an implemented interface or a structural one) also counts, which maps interface members to their implementations. Non-exported functions are searched in their own file and everything else across the program's first-party files. For an exported function, the declaring package's other source files (up to the nearest `package.json`, skipping nested packages, dependencies and build output) are read once per program, and any file outside the program that mentions the name makes the callers unseen. More than 150 name occurrences, 30 files mentioning the name, or 5,000 source files in the package make the edge incomplete; the bounds are recorded in `boundaryObservations.bounds`.

## Message

Anchored at the contract when it is declared in the same file or is a library type such as `Record`, and at the recovery when its owner is another first-party module, which the message names:

> `result` is `ChatResponseResult`, but `TurnResultLike` drops `message.parts[].text` as `string`; the `typeof` check at line 38 re-establishes it.

The rule never suggests a cast.

## Incompleteness

Undecided slots produce no diagnostic. With `ANTIDRIFT_BOUNDARY_OBSERVATIONS` set, each one is appended as a `widening-incomplete` event with its cause, and a fired bound as a `bound-fired` event.

## Measurement

Every run used a frozen copy of `tooling/antidrift/src` at one commit, so editing the source never changed a run in progress. One repository ran at a time, one ESLint process per `tsconfig.json` group with a 4 GB heap, with only the rule under test enabled and ESLint's per-rule timing on. Each sample is 300 TypeScript files drawn by a seeded shuffle of `git ls-files` (dependencies, build output, generated code, fixtures and declaration files excluded), plus the files that hold the labelled sites. Files that no tsconfig includes cannot be typed and are left out of every count below. Findings in test files are listed apart and never count toward precision.

| Repository        | Eligible files | Development sample (seed 20261022): chosen, outside every tsconfig, linted (production + test) | Held-out sample (seed 20261023): chosen, outside every tsconfig, linted (production + test) |
| ----------------- | -------------: | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| cloudflare/agents |          1,852 | 310, 13, 297 (191 + 106)                                                                       | 309, 14, 295 (206 + 89)                                                                     |
| LibreChat         |          5,654 | 305, 19, 286 (168 + 118)                                                                       | 305, 20, 285 (173 + 112)                                                                    |
| opencode          |          5,010 | 306, 0, 306 (217 + 89)                                                                         | 306, 0, 306 (215 + 91)                                                                      |
| agent-native      |         19,798 | 308, 76, 232 (178 + 54)                                                                        | 308, 89, 219 (169 + 50)                                                                     |
| Total             |                | 1,229, 108, 1,121 (754 + 367)                                                                  | 1,228, 123, 1,105 (763 + 342)                                                               |

A finding counts as drift when the slot's contract could carry the producers' type and the recovery would then be unnecessary, with nothing in the code saying the value is untrusted. It counts as debatable when the code documents or plainly signals that the static type is not the run-time contract (a decoder of data whose type was asserted upstream, a version-compatibility shape, a database-driver probe, defensive checks on input from extension code), and as a false positive otherwise.

### Development sample, build `8e1b20d`

27 production findings, one of them A015, so 26 fresh; 5 in test files (A006 and four accumulator round trips in tests).

| Edge      | Fresh findings |   Drift | Debatable | False positive |
| --------- | -------------: | ------: | --------: | -------------: |
| Binding   |              2 |       1 |         0 |              1 |
| Cast      |              6 |       1 |         0 |              5 |
| Parameter |             18 |       4 |         6 |              8 |
| All       |             26 | 6 (23%) |         6 |             14 |

The 14 false positives fell in seven classes: a `case` clause read as a guard on its own recovery (5); a key the producer type does not declare read as `undefined` (4, three in a program without `strictNullChecks`, where `undefined` is assignable to everything); a guard on `tokens[i]` applied to `tokens[i + 1]` (1); a `{}` producer (a narrowed `unknown`) passing `isRecord` (1); a cast used only to write through it, with the other branch's write through `as unknown as` invisible as a producer (1); a generic merge cast back to `T` (1); and a producer that fits an all-optional tree view only vacuously, since parse5's text nodes share no key with it, which TypeScript's weak-type rule rejects (1). Commit `f3d8706` closes all seven, each with a control in `fixtures/programs/correct/round-trip-widening-controls.ts` that the earlier build reported.

Two of the six debatable findings are decoders: functions that take `unknown` and validate data whose static type was asserted upstream (a normalizer of persisted view config, a validator ahead of a schema parse). The rule's claim holds for them, every producer passes and the contract forgets it, and antidrift's own guidance would move the decoding to the I/O boundary, but their authors meant them as boundaries. The other four are a documented AI SDK v6/v7 compatibility shape, a database-driver probe, defensive checks on input from extension code and a coercion of client-supplied history.

Re-run with `f3d8706` on the same sample: the 14 false positives are gone, and 5 findings are new. TypeScript narrows `unknown` to `{}` after a truthiness or `undefined` check, and the earlier build counted `{}` as an object, so `!value || typeof value !== "object"` read as no narrowing. With `{}` admitting primitives those checks are recoveries: one is drift, and four are more decoders, three from the same view-config module and an action-result validator. That leaves 17 fresh production findings: 7 drift, 10 debatable (6 of them decoders), no false positives.

### Held-out sample, build `f3d8706`

The held-out sample was drawn after the fixes and judged once. 18 production findings and 1 in a test file (A006). Eight production findings are sites already judged in the labelled files, which both samples include, and one is new in a labelled file (`production-agent.ts:1950`, drift, from the `{}` change above). The other 9 are fresh and come from the random part of the sample:

| Edge      | Fresh findings |   Drift | Debatable | False positive |
| --------- | -------------: | ------: | --------: | -------------: |
| Binding   |              0 |       0 |         0 |              0 |
| Cast      |              2 |       2 |         0 |              0 |
| Parameter |              7 |       6 |         0 |              1 |
| All       |              9 | 8 (89%) |         0 |              1 |

The drift findings: a queue item and a receipt typed in an in-memory store, cast to `unknown` and re-validated field by field (LibreChat); a helper that takes `unknown` although its only caller has already proved the value `isRecord` (opencode); a search-results formatter whose parameter is `Awaited<ReturnType<typeof search>>`, which loses the document type its caller passes, cast back per hit (agents); a message-text reader handed a LangChain `BaseMessage` (LibreChat); a chunk parser whose only caller passes a string (agent-native); and two copies of `disposeQuietly(resource: unknown)` whose callers pass objects (agents). Several are small. The false positive is `passiveMotionSourceReadCapability(error: unknown)`: its visible callers are spec calls passing typed errors, while its production caller, in a directory the template's tsconfig leaves out, passes a caught `unknown`. Commit `a7a99ac` makes such callers out of view.

### Final build `a7a99ac`

On the same held-out sample the final build reports the same findings except `passiveMotionSourceReadCapability`, now undecided because `actions/get-motion-timeline.ts` names it outside the program. That leaves 8 fresh production findings, all drift: 6 parameter, 2 cast, 0 binding.

### Volume

Counted on the random part of each sample only, since the labelled files were chosen for their sites. With the final build the held-out sample gives 8 fresh production findings in 740 production files, 10.8 per 1,000: agents 3 in 198, LibreChat 3 in 168, opencode 1 in 209, agent-native 1 in 165. The development sample with `8e1b20d` gave 15 in 731 (20.5 per 1,000), most of them false positives.

### Cost

ESLint's per-rule timing, each rule alone in its own process on the development sample. Building the TypeScript program and parsing are shared by every type-checked rule and listed apart.

| Rule                                 | agents (297 linted files) | LibreChat (286) | Per 1,000 files, both |
| ------------------------------------ | ------------------------: | --------------: | --------------------: |
| `no-round-trip-widening` (`f3d8706`) |                    17.8 s |          27.1 s |                  77 s |
| `no-appeasement-cast`                |                    24.9 s |          24.9 s |                  85 s |
| `unknown-input-must-be-decoded`      |                    51.9 s |          83.9 s |                 233 s |
| `no-appeasement-erasure`             |                     0.6 s |           0.2 s |                   1 s |
| Program and parsing, any rule        |              273 to 295 s |      39 to 41 s |                       |

Across all four repositories the rule took 91 s for the 1,121 linted files of the development sample (81 s per 1,000) and 91 s for the 1,105 of the held-out sample (82 s per 1,000), against 1,301 s and 1,328 s of program building and parsing, so it adds about 7% to a type-checked run. Per repository it ranged from 46 s per 1,000 files (agent-native) to 121 s (opencode, whose Effect call sites are the most expensive to check). Peak memory follows the program, not the rule: opencode and agent-native peaked at 3.7 to 4.0 GB, and an earlier run with no rule enabled ran out of a 3.5 GB heap on agent-native's core package. The final build adds, once per program, a walk of each exported function's package and a read of its source files outside the program; timed alone, walking and reading every source file of the largest packages here (3,201 files, 46 MB) took under 0.3 s. The final build's own held-out run shared the machine with another measurement job (load average 6.5 on 4 cores just after it), so its timings are left out. The plan's timing control, Effect's `fromJsonSchemaDocument.ts` (published `effect@4.0.1` source with a scratch tsconfig), took 0.3 s for this rule with no finding and 16 undecided candidates, 0.3 s for `no-appeasement-cast` and 9.1 s for `unknown-input-must-be-decoded`, after 3.1 s of parsing.

### Undecided slots

Undecided is the common outcome. In the held-out sample with `f3d8706`, 628 slots that had a candidate recovery were undecided against 18 reported. The causes, counted per candidate: callers out of view (180), a package entry pointing at an unbuilt `dist` (170), a function with no name its callers can use (95), a producer type that does not resolve (93), a type-predicate implementation (86), a third-party contract (69), a value that escapes before the recovery (67), a contract that does not resolve (55), an unresolved slot or recovered type (34), a generic contract (29) or recovered type (17), more than 30 files naming the function (16), overloads (12) and a slot nothing flows into (11). The outside repositories' workspace packages were not built, so the unbuilt-`dist` and unresolved-type causes stand for what a built checkout would decide.

## Recall

| Site                                             | Plan status | Result                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A015 (`agents`, binding with element write)      | in          | Reported in both samples, anchored at the `properties` annotation.                                                                                                                                                                                                                                                                                                                          |
| A006 (`agents`, cast to a broad type, test file) | in          | Reported in both samples, at `part as Record<string, unknown>`.                                                                                                                                                                                                                                                                                                                             |
| C006 (`agents`, parameter, field level)          | in          | Undecided in the repository: the caller's `ChatResponseResult` comes from `@cloudflare/think`, whose package entry points at an unbuilt `dist`, so the producer does not resolve. A copy of the site with the types inlined (`fixtures/programs/drift/round-trip-widening-parameter-field.ts`) reports through `result.message.parts[].text` with the `part.type === "text"` guard applied. |
| B039 (`agent-native`, `fields` argument)         | partial     | Not reported (see below).                                                                                                                                                                                                                                                                                                                                                                   |
| B029 (`agents`)                                  | blocked     | Undecided: the recovered `Record<string, TaskJson>` comes from an unbuilt `dist` import and does not resolve, as the plan predicted.                                                                                                                                                                                                                                                        |
| A013 (`agent-native`)                            | out         | Not reported; its spec file is outside every tsconfig.                                                                                                                                                                                                                                                                                                                                      |

## Clean controls

The correct fixture holds the plan's named shapes (a dispatcher whose callers jointly pass every member, an optional parameter with a default, a type-predicate implementation, a generic walker), an identity reference, an exported function with no caller, a nullish-only check, a record view of an object contract (the B039 shape), an annotation equal to the inferred type, a lookup table keyed at run time and a mixed accumulator, plus one control per false-positive class above. The out-of-program caller has its own control, `fixtures/programs/correct/round-trip-widening-outside/`: a package whose `.mjs` caller the fixture program, which holds only `.ts` and `.tsx` files, cannot see.

Of the labelled sites judged not drift, every one in a linted file stays clean in both samples and with every build: A012, A018, A020 to A029, B009, B010, B019, B043, B045, C002, C003 and C010. A019 sits in a spec file that no tsconfig includes, so it was not linted. Several are clean because they are undecided rather than cleared: A025 (the contract does not resolve), B009 (exported from the package entry), B045 (with `f3d8706`, the recovered type is generic), A012 (a third-party contract), C010 (a type-predicate implementation).

## Where the plan did not hold

- **The structural difference.** The plan names `boundary/type-difference.ts`. `TypeDifference.differs` finds `any` hiding where a target claims something, under assignability; it is not a set difference and keeps assignability's refusal of an interface where a record is expected. The relation is `widening-cover.ts`; `TypeDifference` only screens the assignability fast path for `any`.
- **B039.** The plan marks B039 partial: `fields` qualifies, `current` only under the structural difference. Applied to the slot as well as the producers, one structural relation makes `object` already a string-keyed record of `unknown`, so casting either parameter to `Record<string, unknown>` excludes nothing and is not a recovery; `fields` qualifies only if the slot is judged by assignability and the producers structurally. The record view of `current` is also the shape of A012, which the labels judge not drift. B039's drift is that two parameters should share a type parameter (`<T>(current: T, fields: Partial<T>)`), a relation between parameters this report condition cannot express. B039 is out, and its shape is a clean control.
- **Keying callers by resolved signature.** `getResolvedSignature(call).declaration` resolves overloads and checks arguments at each call; on Effect-heavy opencode files it took about 35 s for 25 files. Calls are matched by the callee's symbol through aliases and `getRootSymbols` instead, which needs no overload resolution, and overloaded functions are undecided.
- **Callers the program cannot see.** The plan's exemption covers package entry points and identity references. The held-out sample showed a third kind: callers in files of the same package that the tsconfig leaves out. `a7a99ac` reads the package's other source files for the name.
- **Fallbacks at `warn`, and per-edge severity.** The plan reports non-null assertions and `??`/`||` fallbacks at `warn`, and ships an edge kind that misses the gate at `warn`. A rule has one severity per configuration, and `policy:check-rule-surface` treats `warn` as blocking, which an `under-proven` or `defaultOff` rule may not be. Fallbacks are not recoveries in this version, and the rule ships `off`.
- **Tests keep the cast edge.** The plan keeps only the binding edge in tests, but A006, the anchor for the cast edge, is in a test file. Test files keep both local edges; the parameter edge is out.
- **Timing control.** No Effect checkout exists on this machine, so the control ran on the published `effect@4.0.1` source with a scratch tsconfig.

## Severity

Registered `off` in the shipped preset, with status `under-proven` and `defaultOff`. The bar for `error` is 20 fresh findings for each shipped edge kind across three outside repositories at 80% or better, judged by reading the code. The held-out sample, drawn after the development fixes, gave 9 fresh production findings with `f3d8706`, 8 of them drift; its one false positive prompted `a7a99ac`, after which 8 remain, all drift: 6 parameter, 2 cast and no binding. No edge kind comes near 20, and `warn` is no way around that: `policy:check-rule-surface` refuses any enabled severity for an `under-proven` or `defaultOff` rule. At about 11 fresh findings per 1,000 production files, roughly 2,000 more held-out production files would bring the parameter edge to 20; the cast and binding edges need far more.
