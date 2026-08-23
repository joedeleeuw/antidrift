# changelog

## unreleased

- add default-off `no-raw-react-native-touchables`: consumer-configured owner files may import React Native or RNGH interaction primitives, while feature imports, aliases, namespace/default imports, and re-exports receive direct shared-`Touchable` and narrow-adapter remediation

## 0.10.2

- add default-off `no-redundant-local-return-type`: reports only nested local implementations whose final shorthand-object return repeats a direct named type literal and whose calls remain constrained by the immediate enclosing function's explicit return contract; inferred owners, exported/public escapes, contextual callbacks, overloads, recursion, local function dependencies, and broader private-helper annotations stay clean

## 0.10.1

- keep only unknown aliases and chained assertions blocking from the imported syntax rules; return the categorical style, test-seam, reflection, and external-data boundary rules to opt-in after the first real consumer migration showed that their syntax alone cannot distinguish drift from legitimate boundaries
- validate the shared default through the packed consumer without relying on findings from experimental rules

## 0.10.0

- vendor the generic rules and Effect service-constructor rule from `dmmulroy/anti-slop` commit `6d538555cb151d4121ed51a27db81890eacf8ae9`; enable the nine rules with bounded syntax ownership, keep five false-positive-prone rules registered but default-off, make `no-unsafe-cast-chain` own upstream chained-assertion behavior, and incorporate upstream known-value-widening and widen-then-assert detection into `no-appeasement-erasure`
- use one hermetic release verification command locally and in GitHub; keep live external repositories as sequential, named research evidence instead of release or session prerequisites

## 0.9.0

Upgrading from 0.8.0 activates the native TypeScript baseline for consumers of
`createGovernanceOxlintConfig` for the first time: the shipped config pinned
`plugins: ["eslint"]`, which deactivated every `typescript/*` rule. With the
fix the baseline now fires — expect new `typescript/*` findings on first run
(the 21 type-aware rules still require `oxlint-tsgolint` and
`options.typeAware`).

- fix the shipped governance Oxlint config: `plugins` now includes `"typescript"`, so the ~36-rule `typescript/*` baseline (15 syntax, 21 type-aware with `oxlint-tsgolint`) actually activates for consumers; it was silently inert since 0.7.0
- add a deserialization coverage matrix test: the real oxlint binary runs against the shipped governance config and the ESLint typed lane runs in-process, proving every unsafe `JSON.parse` result path reports (`no-unsafe-assignment`/`no-unsafe-type-assertion`/`no-unsafe-argument`/`no-unsafe-return` natively, `no-unsafe-deserialize` on the input side) while boundary forms stay clean

- add default-off `no-sentinel-absence-fallback`: flags `?? "<sentinel>"` on a member read where the fallback is an in-band absence string (`unknown`, `n/a`, `none`, `unavailable`, `error`, `missing`, case-insensitive) — absence coerced to a sentinel reads identically to a real state; motivated by the murderbox type-authority audit's systemd D-Bus reads (`props.ActiveState ?? "unknown"`) and validated against the live drift site in `apps/api/lib/server/chat-runtime.ts`. `||`, numeric sentinels, call/identifier left-hand sides, and display strings outside the sentinel set stay silent

- extend `antidrift/no-schema-validator-transcoding` with the zod source: `toJSONSchema` calls resolved to the zod package count as conversion sources, and one converter wrapper between the representation and the Convex registration is part of the chain. Covers the pattern murderbox remediated in 3a030ff4 and guards against reintroduction

- retire `antidrift/no-query-data-type-parameters`: superseded by the symbol-resolved `no-explicit-type-arguments-on-owned-api`; name-matching flagged unrelated same-named methods, and its ad-hoc key coverage predated the ownership doctrine. Removed from the shipped plugin surface — delete the rule from consumer oxlint configs on upgrade

- add `antidrift inventory-type-owner`: crawls local type alias and interface declarations per repo plan, classifies them against installed-package, registry generated-source, and implicit Convex generated owner candidates with the structural relation engine (`exact-owner-copy`/`loosened-owner-copy`/`partial-owner-copy`), and emits a JSON report with ready-to-accept `ownership.yaml` `packageTypeOwners` proposals for exact installed-package copies; test files are included and tagged `test: true`, accepted owners (Convex, generated registry) stay row-only, and murderbox ships as the first external plan

- repair structural fork fingerprints: optionality, readonly, and method-ness are now encoded per property, and matching classifies `exact-owner-copy` (the only blocking relation on accepted owners), `loosened-owner-copy`, and `partial-owner-copy` (both inventory facts). Accepted owners now match from one property; discovery proposals keep the four-property minimum. The previous fingerprint stripped `| undefined` and skipped methods, so loosened copies fingerprinted as exact

- fix `antidrift/no-redundant-zod-parse`: remove the call-result branches gated on bidirectional type assignability — type equivalence never proves the same decoder ran (refinements are invisible to TypeScript); same-binding decoder provenance remains at error

- add default-off `require-convex-return-validator`: flags registered Convex functions (query/mutation/action and internal counterparts, symbol-resolved through the generated server module) whose object-literal registration lacks a static `returns` validator; real Murderbox drift control (18 functions flagged, zero false positives)
- add default-off `no-schema-validator-transcoding`: flags an Effect `JSONSchema.make` result registered as a Convex `args`/`returns` validator, directly or through one const binding — documentation (OpenAPI) sinks stay clean
- extend `antidrift/no-structural-type-fork` with implicit Convex generated owners: when the active program contains `convex/_generated/dataModel` or `convex/_generated/api`, every `Doc<"table">` (expanded from the generated `DataModel`) and every `FunctionReturnType<typeof api.*>` (read from generated function references) is an accepted fork owner with no registry entry; exact hand-written copies report, while `Doc`/`FunctionReturnType` reference aliases, `Pick`/`Omit` projections, and non-exact shapes stay silent, and files under any `convex/_generated/` path are exempt
- fix `antidrift/no-nonindependent-test-oracle` error-shape echoes firing on black-box server tests: parsing a dynamic response (`schema.parse(await response.json()).error`) and asserting the server's error contract is downstream behavior, not an arranged parse echo; the act's argument must now be an arranged identifier or literal
- add default-off `no-explicit-type-arguments-on-owned-api`: flags caller-supplied type arguments where a registered API owns inference — Convex generated api references and TanStack queryOptions/mutationOptions registrations, both symbol-resolved

## 0.8.0

- add default-off `no-identity-schema-transform` with Zod ownership, closed-shape proof, clean decoder controls, and semantic facts
- extend `antidrift/no-nonindependent-test-oracle` with arranged parse error-shape echoes: `safeParse` issue-path/message assertions and `toThrow`/`rejects` on arranged-bad input report as `errorShapeEcho`

## 0.7.0

Upgrading from 0.6.0 adds the TypeScript baseline to the governance Oxlint
config, so expect new findings on first run.

- ship the ~36-rule `typescript/*` baseline in `createGovernanceOxlintConfig`: 15 syntax rules always, 21 type-aware rules when `oxlint-tsgolint` is installed; `typescriptBaselineTier()` reports which tier resolved, and both halves are exported as frozen constants
- add an Effect Schema branch to `antidrift/no-appeasement-erasure`: curried `Schema.decode*`/`decodeUnknown*` applications count as contract re-establishment
- exempt test files from `antidrift/no-parse-as-cast`; a bare parse of a typed value in a test is a schema-conformance oracle
- extract the schema-derivation trace into `semantic-adapters/schema-provenance`, shared by `no-redundant-zod-parse` and `no-parse-as-cast`

## 0.6.0

Upgrading from 0.5.0 turns on four rules that previously shipped disabled, so
expect new errors on first run.

Enforcement changes:

- enable `antidrift/no-appeasement-cast`, `antidrift/no-nullable-positional-tuple`, `antidrift/no-structural-type-fork`, and `antidrift/no-canonical-model-fork` at error severity; all four shipped `off` in 0.5.0
- `createConfig` now loads the `policy/` registries itself and accepts a `policyDir` option, so `no-structural-type-fork` and `no-canonical-model-fork` receive generated sources, package type owners, and canonical entities without the consumer wiring them by hand

New rules:

- add `antidrift/no-parse-as-cast` at warn severity: reports parsing a parameter whose declared type is `z.infer` of the same schema, where the parse coerces a contract the caller already satisfied instead of validating an untrusted value
- add `antidrift/no-appeasement-erasure` at warn severity: reports widening a known type to `unknown` and then re-establishing a contract from it by parse or named cast
- add `antidrift/no-static-property-loop` to the Oxlint plugin: a literal-key loop that asserts one precomputed object's invariant property values restates declarative shape instead of executing behaviour

Rule coverage:

- extend `antidrift/no-redundant-zod-parse` to synchronous call results, qualified by callee origin so repo-local and `Array`/`ReadonlyArray` members report while external SDK and framework boundaries stay clean
- recognise `safeParse` and `safeParseAsync` across all three Zod rules, closing an escape hatch where switching method silently exited every one of them

Fixes:

- fix `block-generated-policy-edits` matching the whole hook payload, which blocked any edit whose file content merely mentioned a protected filename; it now compares the edit target path

## 0.5.0

- add focused Oxlint governance for registry ownership, anti-suppression, Effect dependencies, and a 1,500-line module limit
- export frozen complexity thresholds for explicit consumer scoping while keeping the strict repository baseline local
- move syntax-only Antidrift rules to Oxlint and retain TypeChecker-dependent rules in ESLint
- scan the repository root by default and exclude generated code only through exact registry declarations
- support TypeScript 6 object flags without consumer patches
- make the packed TypeScript 6 consumer and public package surface part of the blocking check
- split oversized plugin, registry, corpus, and consumer-test modules without compatibility facades

## 0.4.0

- add `no-duplicated-object-field-blocks` — flags copy-pasted zod/typescript field blocks
- add `no-duplicated-conditional-classnames` — flags shared class tokens across both branches of a conditional
- add `react-max-component-props`
- breaking: replace `no-trivial-selector-wrapper` with the broader `no-contract-appeasement-projection`
- breaking: replace `no-bare-membership-assertion` with the broader `no-nonindependent-test-oracle`
- move shell-safety guardrails out of the agent hooks
- add oxlint complexity gate, delegated governance gates, and trusted publishing

## 0.3.0

- enable `no-silent-empty-detection-fallback` as an error in the shared config

## 0.2.0

- first public release: eslint plugin, shareable flat config, agent policy + hook generator
- semantic-proof adapters behind the type-contract and react/query rule families
- breaking: rename `no-coupled-state-setters` → `no-handrolled-resource-lifecycle-cells` (no back-compat alias)
- typed esm entrypoints + `change-contract` inventory command
