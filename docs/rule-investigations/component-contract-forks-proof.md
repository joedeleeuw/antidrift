# Component contract forks: real-artifact acceptance

Issue #39 extends the existing [Homer reproduction harness](../../tooling/antidrift/test/reproduce-homer.mjs) rather than adding a unit test or a hand-written fixture. Run it from the Antidrift repository root under its supported Node runtime:

```sh
node tooling/antidrift/test/reproduce-homer.mjs "$HOMER_CHECKOUT" --owned-projections-only
```

`HOMER_CHECKOUT` is an explicit, read-only local Homer checkout containing both pinned revisions and already-installed dependencies. No host path is baked into the command, and the harness neither fetches nor installs. It archives each revision into temporary directories and links the corresponding existing dependency directories. The supplied checkout remains unchanged.

Omit `--owned-projections-only` to run the same owner assertions followed by the previously reviewed portable/native corpus and JSON repair proof. The scoped flag selects a real-repository acceptance slice; it does not change any assertions in the default command.

## Exact owner assertions

Both `antidrift/no-structural-type-fork` and `antidrift/no-canonical-model-fork` run at error severity against the actual archived client row. The [typed artifact helper](../../tooling/antidrift/test/typed-artifact.mjs) parses the archived client tsconfig, constructs its full source Program, and supplies that Program to the TypeScript ESLint parser. It asserts that the target belongs to the Program. It does not claim that the entire historic client typechecks with current installed dependencies.

| Real Homer revision                        | Required actual ESLint result                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `46ca37f8d690eb6101dbbdad3dd6309375d65306` | Exactly one total diagnostic, structural rule, severity 2, original line 43, message identifying `FunctionArgs<typeof api.conversations.listHistory>["scope"]`. |
| `745c8c59af435a9ae08a1ca9d53983dda8e2c3f3` | Exactly zero total diagnostics on the reduced `showOrigin: boolean` row.                                                                                        |

The stable implementation acceptance run completed with exit 0. Each archived client Program contained 4,948 source files. The original result was:

```text
antidrift/no-structural-type-fork, severity 2
TSUnionType, line 43, column 19, end column 48
Contract copies convex/_generated/api#FunctionArgs<typeof api.conversations.listHistory>["scope"] through a proven owner use — import or derive the projection instead of redeclaring.
```

The boolean revision returned `messages: []`. These are hard assertions on emitted ESLint diagnostics, not on an internal collector, rule enablement, or lint process success alone. Both rules are enabled, but this corpus does not configure a separate canonical entity; it therefore does not independently prove dual-rule overlap deduplication or canonical-owner matching.

## Why the packed consumer gate is unchanged

The existing [consumer monorepo gate](../../tooling/antidrift/test/consumer-monorepo.mjs) creates and installs an isolated synthetic consumer of the packed artifact. It does not own a Homer repository path. Making that ordinary package gate depend on a particular host checkout, network clone, or mandatory environment variable would make it non-portable. The explicit archive command above is a separate corpus acceptance input. The consumer gate remains responsible for shipped exports/configuration and its existing accepted-generated-owner, imported-owner, and unaccepted-package checks.

The historic portable corpus predates `no-wrapping-functions`. The default harness continues asserting the reviewed counts for every currently supported rule in the pinned review (51 rules); it explicitly reports the current unreviewed rule under `unreviewedCustom` instead of inventing an expected count or serializing its absent configuration as a `null` rule option.

## Removed fixture assertions and remaining evidence

Only the `no-structural-type-fork` and `no-canonical-model-fork` suites and their unused local options were removed from the [typed authority suite](../../tooling/antidrift/src/eslint-plugin/typed-authority-rules.test.mjs). No cases were added. The 25 fixture files exclusively used by those suites were deleted after repository-wide references and fixture imports were checked. Shared generated/Convex support was kept. The existing [semantic fact suite](../../tooling/antidrift/src/eslint-plugin/semantic-facts.test.mjs) still uses the full package redeclaration and generated release fork fixtures, so those two were retained.

The mapping below distinguishes direct existing evidence from behavior that is no longer explicitly asserted by a real-artifact gate. Retained fixture-driven semantic-fact assertions are identified as such, not relabeled as runtime smoke coverage.

| Former assertion(s)                                                                                                                                             | Existing evidence or explicit gap                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Imported Firebase usage, intersection extension, discriminated-union composition, Zod `custom` wrapper, barrel re-export, multi-file imported owner, pure alias | Packed consumer accepts its existing clean imported/derived contract. The real boolean row is clean. Neither artifact explicitly isolates every former Firebase/intersection/union/Zod/barrel/multi-file/alias variant: those individual variants are uncovered.                                                         |
| Below-threshold shapes, incompatible property types, generic wrapper                                                                                            | Boolean reduction supplies one real negative contract boundary, but not these former shape/threshold/generic assertions. Those exact behaviors are uncovered.                                                                                                                                                            |
| Unaccepted package full copy, differently named copy, inferred Zod schema mirror, correct import alongside a copy, sibling file copy                            | Consumer explicitly accepts its unaccepted package copy. Retained semantic-fact assertions exercise a full copy as a proposal without a blocking diagnostic. Naming, inferred-schema, mixed-usage, and sibling variants are not independently covered by real artifacts.                                                 |
| Unaccepted partial subset; accepted package partial subset; accepted generated release subset                                                                   | No real-artifact acceptance currently isolates any of these partial-copy assertions. Uncovered.                                                                                                                                                                                                                          |
| Unaccepted optional copy; accepted optional relaxation; accepted readonly relaxation                                                                            | No real-artifact acceptance currently isolates optionality or readonly relaxation. Uncovered.                                                                                                                                                                                                                            |
| Accepted generated release exact copy reports once                                                                                                              | Packed consumer reports its existing accepted generated-owner drift and verifies its semantic fact. Retained semantic-fact assertions still report the generated release exact copy once with stable fact IDs. The real Homer row adds exactly one use-proven argument projection, not the same generated release shape. |
| Accepted Firebase full exact copy reports once                                                                                                                  | Retained semantic-fact assertions still report its accepted package exact copy once. No new real-repository corpus explicitly isolates that installed-package owner.                                                                                                                                                     |
| Convex `Doc` references, `Pick`/`Omit`, return aliases/projections stay clean                                                                                   | The actual boolean row remains clean but does not isolate these projection forms. Those former isolated assertions are uncovered.                                                                                                                                                                                        |
| Convex renamed/retyped/extra-property near misses stay clean                                                                                                    | The actual boolean row proves that particular owner-independent reduction only. The other former near-miss assertions are uncovered.                                                                                                                                                                                     |
| Convex exact `Doc` and `FunctionReturnType` copies report once                                                                                                  | The real archive proves an anonymous `FunctionArgs` field projection at the actual owner use. It does not explicitly isolate exact `Doc` or return-shape copies. Those prior exact-copy variants are uncovered.                                                                                                          |
| Canonical source is clean; optional form draft is clean; partial list item is clean; exact canonical copy reports once                                          | No separate canonical entity is configured for the Homer row, and the unchanged packed consumer does not assert these four canonical behaviors. All four are explicitly uncovered by this real-artifact proof.                                                                                                           |

## Validation and existing full-corpus blocker

The orchestrator reran the scoped archive command against the final implementation: exit 0, original exactly one error and boolean revision zero, with 4,948 source files per Program. The required root `pnpm policy:verify-session` completed with exit 0: generated policy, registries, rule surface, validation corpus, typecheck, both lint tiers, 52 existing test files / 1,191 tests, and the packed consumer monorepo gate. Focused ESLint validation and `git diff --check` also passed. The artifact command is additional acceptance evidence, not a substitute for the root gate.

Independent read-only review reproduced and closed a nested owner-derived wrapper false positive. Strict in-memory Programs preserved fully derived wrappers and independent lookalikes while the handwritten nested positive still emitted exactly one error with both rules enabled. Closed verification also kept asserted/`any` source origins, shorthand source embedding, and nullable/reference union compositions silent; the stable exhaustive parameter bridge remained a positive. These temporary review experiments added no tests or fixture files and are not claimed as a durable corpus gate.

The default reproduction executed the owner 1/0 assertions and all 51 historic supported custom count assertions, and accepted the native inventory selection. It then failed in the existing JSON proof's **before** typecheck for the pinned `dc7d554d9925f5a4e6adc73844e8cd1b6057c3fc` archive:

```text
apps/api/lib/server/agent-runtime-config.ts(9,3): error TS2724:
'"@homer/agents"' has no exported member named 'normalizeAgentRuntimeConfig'.
Did you mean 'AgentRuntimeConfig'?
```

The linked local dependency/package build is not the historical package surface. No dependency install, manifest change, lockfile edit, or assertion retuning was performed to conceal that blocker. The [JSON proof helper](../../tooling/antidrift/test/reproduce-homer-json.mjs) only gained diagnostic formatting in its existing error branch so this concrete mismatch is visible. Its Program, repair, expected diagnostics, and typecheck assertions remain unchanged. Full-corpus success is not claimed; the scoped issue #39 owner acceptance succeeds independently.
