# changelog

## 0.6.0

- add `antidrift/no-parse-as-cast` at warn severity: reports parsing a parameter whose declared type is `z.infer` of the same schema, where the parse coerces a contract the caller already satisfied instead of validating an untrusted value
- add `antidrift/no-appeasement-erasure` at warn severity: reports widening a known type to `unknown` and then re-establishing a contract from it by parse or named cast
- recognise `safeParse` and `safeParseAsync` across all three Zod rules, closing an escape hatch where switching method silently exited every one of them
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
