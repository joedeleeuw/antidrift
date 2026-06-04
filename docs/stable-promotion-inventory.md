# Stable Promotion Inventory

This is the promotion ledger for the implemented rule set. It is stricter than `ready`: a stable rule needs at least two independent real repositories with non-test-created drift replication, clean controls, zero known false positives, zero known false negatives, no unresolved production concerns, and a grounded Claude advisory review.

This table is derived from `policy/registries/rules.yaml`, `tooling/antidrift/src/policy/chaski-corpus.mjs`, and `tooling/antidrift/src/policy/external-corpus.mjs`. Reduced fixtures do not count.

## Stack Rank

| Rank | Rule                                    | Promotion bucket               | Drift repos                      | Clean repos                       | Why                                                                                                                                                                               |
| ---: | --------------------------------------- | ------------------------------ | -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `antidrift/no-appeasement-cast`         | classification-required        | Chaski, Codebase Atlas, Sudocode | Chaski, antidrift                 | Broad inventory replicated the signal across three real repos, but findings are unclassified. Stable is blocked on generic/API-wrapper, production, and test-file classification. |
|    2 | `antidrift/no-async-array-method`       | needs drift replication        | Sudocode                         | Chaski, Codebase Atlas, Sudocode  | Clean breadth exists and broad inventory found no Chaski/Codebase Atlas findings, but drift is currently only Sudocode.                                                           |
|    3 | `antidrift/no-unsafe-deserialize`       | needs drift replication        | Sudocode                         | Chaski, Codebase Atlas, Sudocode  | Type-aware clean breadth exists, but broad-input JSON.parse drift is currently only Sudocode.                                                                                     |
|    4 | `antidrift/no-raw-fetch-in-component`   | scope decision                 | Chaski, Codebase Atlas           | Chaski, Sudocode                  | Independent drift now exists; stable is blocked on whether this stays fetch-specific or becomes a raw transport boundary rule.                                                    |
|    5 | `antidrift/no-redundant-zod-parse`      | test assertion scope decision  | Chaski, Murderbox                | Chaski, Codebase Atlas, Murderbox | External production drift and clean controls now exist; stable is blocked on whether typed schema-contract assertions in tests should be exempt or reported.                      |
|    6 | `antidrift/no-silent-catch`             | needs external clean and drift | Chaski                           | Chaski                            | Needs another repo with accepted empty or console-only catch drift and clean rethrow/handled catches.                                                                             |
|    7 | `antidrift/no-sql-string-concat`        | needs external clean and drift | Chaski                           | Chaski                            | Needs another SQL/HogQL interpolation case plus parameterized-query clean controls.                                                                                               |
|    8 | `antidrift/no-status-literal-in-type`   | needs external clean and drift | Chaski                           | Chaski                            | Needs another configured status-owner repo with a real local status union redeclaration.                                                                                          |
|    9 | `antidrift/no-trivial-selector-wrapper` | needs external clean and drift | Chaski                           | Chaski                            | Needs another non-name-gated selector wrapper in real source.                                                                                                                     |
|   10 | `antidrift/no-unsafe-cast-chain`        | needs external clean and drift | Chaski                           | Chaski                            | Needs another `as unknown as T` tunnel in real source.                                                                                                                            |
|   11 | `antidrift/require-effect-deps`         | needs external clean and drift | Chaski                           | Chaski                            | Needs another missing dependency-array effect case outside Chaski.                                                                                                                |

## Blocked From Stable Promotion

These rules are implemented and may be `ready`, but they have unresolved concerns that block stable promotion even if they have local evidence.

| Rule                                              | Blocker                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-canonical-model-fork`               | Requires explicit configured owners and broader inventory for boundary DTO/view-model overlap.                                |
| `antidrift/no-coupled-state-setters`              | Broad Chaski inventory has many findings; needs cleanup/classification before broad claims.                                   |
| `antidrift/no-defensive-shape-probing`            | Has clean breadth, but only one drift repo and still needs broad inventory for the `any`/`unknown` entries signal.            |
| `antidrift/no-hover-translate-card`               | CSS `@apply hover:-translate-*` remains outside JSX extraction.                                                               |
| `antidrift/no-inline-structural-type-at-use-site` | Local UI props and callback payload exclusions need more independent pressure.                                                |
| `antidrift/no-nullable-positional-tuple`          | Type alias/generic-chain nullability depends on parser services; imported owner range aliases are intentionally out of scope. |
| `antidrift/no-obvious-comment`                    | Heuristic/token-overlap rule; not stable until another inventory proves low noise.                                            |
| `antidrift/no-raw-tailwind-color`                 | Broad Chaski inventory has many findings; needs cleanup/classification before broad claims.                                   |
| `antidrift/no-status-triplet-state`               | Heuristic by nature; stable needs multiple low-noise inventories.                                                             |
| `antidrift/no-structural-type-fork`               | Installed-package and generated-source variants need independent replication and boundary DTO clean pressure.                 |
| `antidrift/no-underchecked-type-predicate`        | Needs a second real underchecked broad-input predicate drift case.                                                            |
| `antidrift/require-authz-check`                   | Current implementation is Express-style and does not prove tRPC procedure authorization coverage.                             |

## Under-Proven Rules

These remain implemented but not promotable because we still lack real drift evidence.

| Rule                                | Current state                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `antidrift/no-cast-to-branded`      | Codebase Atlas has clean Zod-brand parse boundaries, but no real forged branded cast.       |
| `antidrift/no-role-literal-in-type` | Chaski has clean role ownership/runtime controls, but no accepted role union redeclaration. |

## Next Slice

Work on `antidrift/no-appeasement-cast` first. Broad inventory and grounded advisory review are complete enough to define the next slice: classify the findings before changing rule behavior or stable status.

1. Classify every remaining production finding, not only representative examples.
2. Collect cleanup/remediation evidence for the production drift patterns.
3. Decide whether BFF, Codebase Atlas, and Sudocode test-file findings should keep reporting or receive a focused test override.
4. Keep `stable: false` until classification leaves no unresolved concerns.
