# Lint Rule Parity

This ledger tracks the old Oxlint baseline rule-by-rule now that ESLint is the only lint engine. A rule can leave this table only when the replacement is enforced in `tooling/antidrift/src/eslint-config/index.mjs` or the gap is explicitly accepted here.

| Former Oxlint rule | ESLint replacement | Status |
|---|---|---|
| `typescript/no-explicit-any` | `@typescript-eslint/no-explicit-any` | Covered |
| `typescript/no-empty-object-type` | `@typescript-eslint/no-empty-object-type` | Covered |
| `typescript/no-extra-non-null-assertion` | `@typescript-eslint/no-extra-non-null-assertion` | Covered |
| `typescript/no-non-null-asserted-optional-chain` | `@typescript-eslint/no-non-null-asserted-optional-chain` | Covered |
| `typescript/no-unsafe-function-type` | `@typescript-eslint/no-unsafe-function-type` | Covered |
| `typescript/no-wrapper-object-types` | `@typescript-eslint/no-wrapper-object-types` | Covered |
| `typescript/no-misused-new` | `@typescript-eslint/no-misused-new` | Covered |
| `typescript/no-unsafe-declaration-merging` | `@typescript-eslint/no-unsafe-declaration-merging` | Covered |
| `typescript/no-duplicate-enum-values` | `@typescript-eslint/no-duplicate-enum-values` | Covered |
| `typescript/prefer-as-const` | `@typescript-eslint/prefer-as-const` | Covered |
| `no-console` | `no-console` | Covered; disabled for tooling |
| `no-debugger` | `no-debugger` | Covered |
| `no-array-constructor` | `no-array-constructor` | Covered |
| `no-warning-comments` | `no-warning-comments` with `@nocommit` and `FIXME` | Covered |
| `vitest/no-focused-tests` | `no-only-tests/no-only-tests` | Covered for `.only` across test frameworks |
| `react/jsx-key` | `react/jsx-key` from `eslint-plugin-react` | Covered |
| `react/jsx-no-target-blank` | `react/jsx-no-target-blank` from `eslint-plugin-react` | Covered |
| `react/jsx-no-duplicate-props` | `react/jsx-no-duplicate-props` from `eslint-plugin-react` | Covered |
| `react/no-danger-with-children` | `react/no-danger-with-children` from `eslint-plugin-react` | Covered |
| `react/no-unknown-property` | `react/no-unknown-property` from `eslint-plugin-react` | Covered |
| `react/no-children-prop` | `react/no-children-prop` from `eslint-plugin-react` | Covered |
| `react/jsx-no-undef` | `react/jsx-no-undef` from `eslint-plugin-react` | Covered |
| `react/jsx-no-comment-textnodes` | `react/jsx-no-comment-textnodes` from `eslint-plugin-react` | Covered |
| `unicorn/no-abusive-eslint-disable` | `unicorn/no-abusive-eslint-disable` from `eslint-plugin-unicorn` | Covered |
| `unicorn/prefer-node-protocol` | `unicorn/prefer-node-protocol` from `eslint-plugin-unicorn` | Covered |
| `unicorn/prefer-structured-clone` | `unicorn/prefer-structured-clone` from `eslint-plugin-unicorn` | Covered |
| `curly` | `curly` with `multi-line` | Covered |

No accepted gaps are currently recorded.
