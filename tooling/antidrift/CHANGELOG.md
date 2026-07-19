# changelog

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
