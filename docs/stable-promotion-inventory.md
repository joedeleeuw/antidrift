# Stable Promotion Inventory

This is the promotion ledger for the implemented rule set. It is stricter than `ready`: a stable rule needs at least two independent real repositories with non-test-created drift replication, clean controls, zero known false positives, zero known false negatives, no unresolved production concerns, and a grounded Claude advisory review.

This table is derived from `policy/registries/rules.yaml`, `tooling/antidrift/src/policy/chaski-corpus.mjs`, and `tooling/antidrift/src/policy/external-corpus.mjs`. Reduced fixtures do not count.

## Stack Rank

| Rank | Rule                                    | Promotion bucket               | Utility lens                       | Drift repos                      | Clean repos                                         | Why                                                                                                                                                                                                                                                                        |
| ---: | --------------------------------------- | ------------------------------ | ---------------------------------- | -------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `antidrift/no-appeasement-cast`         | remediation-patterns-proven    | pause remediation                  | Chaski, Codebase Atlas, Sudocode | Chaski, Codebase Atlas, antidrift                   | Type-escape hatches are core scope; upstream benchmark proved `@typescript-eslint/no-unsafe-type-assertion` is a much broader superset. Copy-backed repairs now prove caught-error, serialized-storage, schema-backed object-contract, and third-party bag guard patterns. |
|    2 | `antidrift/no-unsafe-deserialize`       | stable                         | monitor                            | Sudocode, Cloudflare Agents      | Chaski, Codebase Atlas, Sudocode, Cloudflare Agents | Parse-at-edge is core scope; type-aware clean breadth exists, drift replicates across two repos, guarded `MessageEvent.data` parses are handled, Claude advisory completed, and type-aware fail-open behavior now reports a config error.                              |
|    3 | `antidrift/no-redundant-zod-parse`      | helper-shape limits            | continue                           | Chaski, Murderbox                | Chaski, Codebase Atlas, Murderbox                   | Parse-at-edge/reparse discipline is original scope; external production drift exists, typed schema-contract assertions are excluded only in direct throw assertion callbacks, and the missing consumed-assertion negative gate is accepted as unrepresented in current corpus. |
|    4 | `antidrift/no-raw-fetch-in-component`   | advisory review needed         | promote after review                | Chaski, Codebase Atlas, Murderbox | Chaski, Sudocode, Murderbox                         | Scope is resolved as fetch-specific; `globalThis.fetch` is now covered, and Murderbox adds both component-module drift plus a clean API-proxy control. Broader raw transport ownership is a separate future rule only if non-fetch corpus evidence appears.              |
|    5 | `antidrift/no-sql-string-concat`        | needs external clean and drift | continue                           | Chaski, Sudocode                 | Chaski, Codebase Atlas                              | Injection-boundary policy remains valuable; `pnpm policy:benchmark-sql-queries` reports 12 custom findings and 0 SonarJS findings, but stable still needs stronger parameterized-query clean replication.                                                                  |
|    6 | `antidrift/no-trivial-selector-wrapper` | needs external clean and drift | continue                           | Chaski                           | Chaski                                              | Structural inference-appeasement wrappers are core type-contract scope; needs another non-name-gated selector wrapper in real source.                                                                                                                                      |
|    7 | `antidrift/require-effect-deps`         | needs external clean and drift | continue                           | Chaski                           | Chaski                                              | Exhaustive-deps misses the no-array case; needs another missing dependency-array effect case outside Chaski.                                                                                                                                                               |
|    8 | `antidrift/no-async-array-method`       | needs drift replication        | defer unless another drift appears | Sudocode                         | Chaski, Codebase Atlas, Sudocode                    | Deterministic and narrow, but clean breadth plus only one test-file drift makes it lower leverage than core type/validation/security rules.                                                                                                                                |
|    9 | `antidrift/no-status-literal-in-type`   | needs external clean and drift | defer                              | Chaski                           | Chaski                                              | Registry-backed domain vocabulary is useful, but status literal replacement can wait until another configured status-owner repo produces real drift.                                                                                                                       |
|   10 | `antidrift/no-unsafe-cast-chain`        | needs external clean and drift | defer behind `no-appeasement-cast` | Chaski                           | Chaski                                              | The broader appeasement-cast rule covers the higher-value type-escape surface; keep this narrow tunnel rule, but do not prioritize stable promotion.                                                                                                                       |

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

The `antidrift/no-redundant-zod-parse` test assertion scope decision is implemented: schema-contract reparses inside direct throw assertion callbacks are clean, while production service-to-boundary reparses and same-schema value reparses still report. Claude Opus 4.8 advisory review completed on June 4, 2026; the follow-up real-test scan found no consumed-parse-in-assertion case across Codebase Atlas, Murderbox, Sudocode, or Chaski, so that missing gate is accepted as unrepresented in current corpus.

1. Keep Chaski and Murderbox production reparse cases as drift gates.
2. Keep Codebase Atlas schema-contract assertion files as clean gates.
3. Decide whether to fix or explicitly accept inline awaited service-result reparses and sync helper-result reparses before stable promotion.
