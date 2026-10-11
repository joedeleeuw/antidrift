# changelog

## Unreleased

- `no-nonindependent-test-oracle`: the registry's input, outcome, error-shape and mock-call echo `flags` examples now sit inside an `it(...)` callback. The rule bounds arrangement to the enclosing test callback, so the bare snippets never reported; rule behavior is unchanged

## 0.15.0

- `no-schema-library-in-test`: schema-library value imports report only for test-owned validation, reads or sanitizing. Schema values and errors that flow straight into application APIs (call or constructor arguments, JSX props), e.g. `generateForm(z.object(...))` or `new FormError(new ZodError([]))`, are allowed; dynamic `import()` and side-effect imports still report

- `no-validator-output-oracle`: `parse`/`safeParse` (and `assert`/`decode`/`validate`) count as validator calls only when the receiver is proven to be a runtime schema, by TypeScript types in the typed ESLint pass or by binding provenance to a schema-library import. This replaces method-name inference and the JSON/YAML/path receiver-name exemptions, so application parsers stay clean and shadowing aliases such as `const JSON = UserSchema` report

- `no-nonindependent-test-oracle`: a length echo is not reported when a sibling independent full-equality assertion on the same collection proves its contents; block facts are cached per test so analysis is linear in assertion count

- `no-inline-structural-type-at-use-site`: the JSX-returning exemption covers returns nested in if/switch/try/loop blocks (not nested functions); exported objects and functions wrapped in `satisfies`/`as` are checked as boundaries; constructors and accessors report only on exported classes

- `no-duplicated-object-field-blocks`: repeated field blocks are found even when one of their fields also appears in other shapes, using a bounded near-linear search over field-occurrence intersections

- `no-open-dictionary-at-boundary`: generic constraints and defaults of exported functions are inspected, and exported functions wrapped in `satisfies`/`as` are unwrapped

- `no-redeclared-owned-union`: the message says "owned literal value space" so numeric unions are described correctly

- `unknown-input-must-be-decoded`: guard operands (`typeof`, `!`, `instanceof`, `in`, equality) are exempt only when the guard steers control flow (a branch, loop, conditional or switch test, a short-circuit left operand, or a type-predicate return); `return typeof input` and `{ missing: !input }` report

- `no-fallback-to-empty`: empty collections are matched through `as`/`satisfies`/`!`/`<T>` and chain wrappers, and block-bodied `.catch` handlers that return `[]`/`{}` and drop the error report. The Oxlint governance preset excludes `**/fixtures/**` for this rule

- `no-silent-empty-detection-fallback`: a directly returned empty string from a detection helper reports (source `ast-direct-empty`), `hostname` is a detection token, and names containing `format`/`render`/`display` are not detection helpers

- `no-calling-components-as-functions`: files importing Solid, Qwik, Vue, or Preact without `preact/compat` are skipped; `forwardRef`/`memo` count as wrappers only when they resolve to React imports, aliases included; local `const Alias = Component` bindings are followed and JSX returns nested in if/try/loop blocks are found

- `no-raw-react-native-touchables`: React Native `Button` and gesture-handler `BaseButton`/`BorderlessButton`/`RawButton`/`RectButton` are forbidden, and `{ default as X }` imports and re-exports from React Native report as broad namespace access

- `no-duplicated-conditional-classnames`: configured helpers (`cn`, `clsx`) see conditionals nested inside array, object and spread arguments, e.g. `cn([ok ? "a b" : "a c"])`

- `no-vague-names`: matches the G21 patterns: vague nouns ignore case (`DATA`), snake_case filler affixes (`user_data`, `my_config`) and numbered abbreviations (`req2`) report, uppercase `I`/`J`/`K`/`N`/`X`/`Y` are allowed, and `props` reports again outside a component's first parameter

- `no-compat-names`: names bound inside destructuring patterns in declarations and parameters are checked

- `no-pass-through-parameters`: parameters forwarded through `void call(...)` and calls to local functions whose initializers are wrapped in `as`/`satisfies`/`!` report

- `no-hash-literal`: hash literals wrapped in TypeScript assertions such as `as const` report

- the ESLint ratcheted pass covers `.mts` and `.cts` files and skips minified bundles (`**/*.min.{js,mjs,cjs}`)

- `unknown-input-must-be-decoded`: use means member reads, casts, coercions and returns. Forwarding the whole unknown value as a call argument is no longer reported, because the receiving function owns the decoding; built-in coercions and serializers (`String`, `Number`, `Boolean`, `BigInt`, `JSON.stringify`, `Response.json`) and template interpolation still are. Branch and if-exit guards (`typeof`, `instanceof`, `in`, `Array.isArray`) narrow later reads in the same block, and truthiness tests, null comparisons and control-flow guard operands are not use. Casts report even behind a guard

- enable fourteen syntax rules at error in the ESLint pass, ratcheted by `eslint-suppressions.json`; the Oxlint plugin still exports them but the Oxlint governance config no longer lists them: `no-nonindependent-test-oracle`, `no-validator-output-oracle` and `no-schema-library-in-test` (G15); `no-inline-structural-type-at-use-site`, `no-duplicated-object-field-blocks` and `no-redeclared-owned-union` (W4); `no-open-dictionary-at-boundary` and `unknown-input-must-be-decoded` (G4); `no-sentinel-absence-fallback` and `no-silent-empty-detection-fallback` (G7); `no-raw-fetch-in-component` and `no-raw-react-native-touchables` (G11); `no-duplicated-conditional-classnames` and `no-calling-components-as-functions`. The rule registry declares W4 and G11. Consumers add these rules to their one-time `eslint . --suppress-rule ...` baseline and commit `eslint-suppressions.json`

- `no-raw-react-native-touchables`: every React Native repository routes presses through one shared Touchable. With no `allowedFiles` owner configured, each raw touchable import reports with advice to create one shared Touchable module, import it everywhere, and register it as the rule's owner so the owner file alone may import the raw primitives; the configured exact-owner exemption and its remediation message are unchanged

- `unknown-input-must-be-decoded`: decoders own their unknown parameter. Parameters of type predicates and assertion functions (`x is T`, `asserts x is T`) are exempt, as are helpers whose single returned expression only narrows the parameter (typeof, `in`, instanceof, `Array.isArray` and null checks joined by `&&` or `||`, with a final property comparison). Casts and unnarrowed reads still report

- `no-calling-components-as-functions`: report only when the callee resolves in scope to a function or arrow that lexically returns JSX, or to a `forwardRef`/`memo` wrapper. Imported and otherwise unresolvable callees are no longer reported, so action creators, minified bundles and generated clients stay clean

- add directive rules, each naming its AGENT.md directive in the rule registry's new `directive` field (validated against a declared `directives` table): `no-pass-through-parameters` (G22), `no-vague-names` (G21) and `no-compat-names` (G5) at error in the ESLint pass, ratcheted by `eslint-suppressions.json`; `no-fallback-to-empty` (G7, promoted from research), `no-else-if-chain` (G9), `no-hash-literal` (S1), `no-host-path-literal` (S4) and `no-dated-comments` (S5) at error in the Oxlint governance preset. G8 maps to native `no-nested-ternary`, owned outside Antidrift. `eslint-suppressions.json` is a protected policy file. Consumers baseline once with `eslint . --suppress-rule ...` and commit the file

- Fix implicit Convex ownership false positives: exact shape alone is inventory, not proof that an independent local contract forks the API. Require a proven contextual owner use for automatic owners, and detect cross-file named alias/interface argument copies consumed by real API calls, including `FunctionArgs<Query> | "skip"` contexts. Keep explicit generated/package/domain exact-match policy, shared property equivalence, output provenance, and whole-Program discovery unchanged.

- **Breaking:** extract reusable generic enforcement into the independent `@joedeleeuw/typescript-tooling` package. Antidrift's ESLint factory now owns only its custom TypeChecker rules; its Oxlint governance factory owns custom drift rules, registry-aware restricted imports, generated ignores, and gateway exemptions. Compose tooling's `/eslint` and `/oxlint` entrypoints explicitly to retain SQL safety, enum/React 19 restrictions, lint-directive checks, the 1500-line cap, and the conditional native TypeScript baseline.
- Remove `antidriftComplexityRules`, the prefixed TypeScript maps, `typescriptBaselineTier`, and `@joedeleeuw/antidrift/adoption-config` without aliases. Use tooling's `complexityRules`, `typescriptSyntaxRules`, `typescriptTypeAwareRules`, `typescriptBaselineTier`, `adoptionPresets`, and `createAdoptionOxlintConfig` from `/oxlint`. The repository configs and packed-consumer evidence now use both actual package owners.

- Fix [#39](https://github.com/joedeleeuw/antidrift/issues/39): share accepted-owner provenance between `no-structural-type-fork` and `no-canonical-model-fork` to detect handwritten anonymous/nested, named-alias, and interface projections at contextual uses, including component props, without removing the syntax rule's JSX exemption. Discover Convex `FunctionArgs` alongside return/document owners, retain pure-object unions without flattening them, and certify identity-preserving exhaustive constructor discriminants only for stable value bindings. Keep independent lookalikes, widened/uncertain contracts, and imported/derived owner references quiet; suppress overlapping diagnostics. Extend the existing real Homer archive reproduction with the original copied-scope and repaired boolean-prop revisions. See the README and real-artifact proof for conservative limits and removed fixture-suite coverage gaps.

## 0.14.0

- `unknown-input-must-be-decoded` and `no-unknown-parameters`: exempt the positions where `unknown` is the honest annotation — rejection-handler parameters (the `promise.catch(...)` callback and the `onRejected` argument of `promise.then(...)`, inline or passed by name; the fulfillment handler still reports) and output parameters whose every read is the serialized-value argument of an unshadowed-global `JSON.stringify` or `Response.json`. The sink must stay pure: feeding the result to `JSON.parse`, drilling into it (`Response.json(x).json()`), or passing a function replacer keeps the annotation reported, as do unused or reassigned parameters, constructor parameter properties, and any other read. In `unknown-input-must-be-decoded` a rejection-handler parameter is still analysed per read: assertions, member access, `typeof` operands, and the right side of `in` report, while forwarding reads (call arguments, `throw`, `cause:` properties, `instanceof` discriminations) stay allowed. Shared detection lives in `oxlint-plugin/unknown-sinks.js`. Both rules remain default-off

- `no-runtime-typeof`: exempt capability checks only when the operand is rooted at an unshadowed platform global (`window`, `document`, `navigator`, `globalThis`, `self`, `global`, `process`, `localStorage`, `sessionStorage`), including optional member chains, and the result is compared with `"undefined"` or `"function"` — those probe the host environment, not an unparsed value. Any other comparison, a bare `typeof`, or a local binding that reuses a global's name still reports. The `allowInTypeGuards` option stays default-off; hand-written guard functions over `unknown` remain under the ratchet in favor of named schemas. The rule remains default-off

## 0.13.0

- migrate `antidrift/no-redundant-zod-parse` to the Oxlint syntax tier as its single owner, and re-scope detection from same-binding symbol identity to canonical-path provenance. The receiver may now be a member expression, so contract-first architectures are covered for the first time: `contract.getPost.responses[200].parse(post)`, `method.resultSchema.parse(info)`, and const aliases of either unify with the site that produced the value. Literal computed keys resolve; dynamic segments, calls in the receiver chain, rebound roots, writes to any prefix of the path, and values mutated or escaped into a call between the two sites all bail silently. `safeParse` provenance flows through the result object (`r.data` and `const { data } = ...`), and `S.safeParse(ownOutput)` reports separately as dead defensive validation rather than being exempted. Escape analysis walks whole argument expressions, assignment right-hand sides, and closures, and a call to a same-file function carries that function's own writes and escapes transitively — function declarations hoist, so a source-order window cannot see a mutator declared below the site it affects. No type-identity or assignability signal is used anywhere. **Breaking for consumers:** the ESLint plugin no longer exports this rule — remove `antidrift/no-redundant-zod-parse` from ESLint configs and enable it in Oxlint instead. It ships default-off on this release under the graduated rollout doctrine

- add default-off `no-repo-state-mirror-assertion`: in test files, flags assertions that compare values derived from configured repo-state loaders (confs, manifests, registries) against literals, and null/existence pins on literal-keyed lookups into those loaders — such tests restate data the repo already defines, prove no behavior, and break on every legitimate tune. Configure `sources: [{ module, names? }]` with the loader import origins; relational assertions, invariants, and fixture-owned data stay silent. Motivated by the murderbox conf.test.ts sweep (43 mirror tests, 1,636 lines removed by hand)

- fix the package top entry as an Oxlint plugin specifier: `jsPlugins: [{ specifier: "@joedeleeuw/antidrift" }]` crashed with `Cannot destructure property 'rules' of 'plugin' as it is undefined` because the root entry had no default export — Oxlint's loader reads the default export of the given specifier. The root now re-exports the Oxlint plugin as its default (named exports unchanged), and a registration test drives the real oxlint binary through the top entry. The governance Oxlint config now names the plugin by its package specifier instead of an absolute file path into node_modules — the workaround that path represented is gone with the bug

## 0.12.0

- Enable `antidrift/no-wrapping-functions` at error severity by default. It reports named declarations and named arrow/function expressions that only delegate a call, including exports. Inline callbacks and computations stay outside the rule; no automatic fix is provided.
- Remove delegation-only helpers from Antidrift's own implementation and exercise default enforcement through an installed package in the consumer smoke.
- Replace the `defaultAstGrepConfig()` policy export with the static `DEFAULT_AST_GREP_CONFIG` path. Consumers should read the constant directly.

## 0.11.0

- Resolve optional research checkout defaults from the current user's home directory instead of shipping maintainer-local absolute paths.
- Enable 51 portable agent guardrails with configurable owners, local import provenance, package-boundary resolution and default/typed fetch aliases; withdraw eleven provisional detectors after per-rule agent-intent review.
- Export 436 native rules in eleven named opt-in adoption presets, excluding eighteen Next entries and preserving existing complexity budgets.
- Extend no-unsafe-deserialize to parsed JSON assigned into declared domain contracts, including immutable aliases.
- Replace the synthetic 148-sample claim with complete source authenticated by Git commit/tree/blob proofs and exact diagnostics at the pinned Homer revision.
- Include the verified upstream NOTICE, pinned module provenance and complete Apache license text. Verify every new custom rule and every native preset category through the packed consumer artifact.

## 0.10.4

- narrow `no-mocked-response-body-oracle` to response expectations that statically match a value arranged by a mock in the same test; transformed responses, canonical error mappings, and additive-field stripping remain clean

## 0.10.3

- add default-off `no-raw-react-native-touchables`: consumer-configured owner files may import React Native or RNGH interaction primitives, while feature imports, aliases, namespace/default imports, and re-exports receive direct shared-`Touchable` and narrow-adapter remediation
- add default-off `no-schema-library-in-test` for runtime-schema value imports/requires in test files while preserving type-only imports
- add default-off `no-validator-output-oracle` for assertions that trace through local bindings and transparent projections to direct validator output or validator-only throw callbacks
- add default-off `no-mocked-response-body-oracle` on both syntax plugin exports: within one test callback, report object/array shape assertions tracing to `response.json()` when a supported mock arrangement supplies the boundary; recommend deleting pure mock echoes and retaining only independently owned effects

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
