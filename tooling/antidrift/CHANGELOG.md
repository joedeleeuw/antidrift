# changelog

## Unreleased

- fix `antidrift/no-nonindependent-test-oracle` error-shape echoes firing on black-box server tests: parsing a dynamic response (`schema.parse(await response.json()).error`) and asserting the server's error contract is downstream behavior, not an arranged parse echo; the act's argument must now be an arranged identifier or literal

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
