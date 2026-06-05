# Stable Promotion Inventory

This is the promotion ledger for the implemented rule set. It is stricter than `ready`: a stable rule needs at least two independent real repositories with non-test-created drift replication, clean controls, zero known false positives, zero known false negatives, no unresolved production concerns, and a grounded Claude advisory review.

This table is derived from `policy/registries/rules.yaml`, `tooling/antidrift/src/policy/chaski-corpus.mjs`, and `tooling/antidrift/src/policy/external-corpus.mjs`. Reduced fixtures do not count.

## Stack Rank

| Rank | Rule                                    | Promotion bucket               | Utility lens                       | Drift repos                       | Clean repos                                         | Why                                                                                                                                                                                                                                                                                 |
| ---: | --------------------------------------- | ------------------------------ | ---------------------------------- | --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `antidrift/no-appeasement-cast`         | remediation-patterns-proven    | pause remediation                  | Chaski, Codebase Atlas, Sudocode  | Chaski, Codebase Atlas, antidrift                   | Type-escape hatches are core scope; upstream benchmark proved `@typescript-eslint/no-unsafe-type-assertion` is a much broader superset. Copy-backed repairs now prove caught-error, serialized-storage, schema-backed object-contract, and third-party bag guard patterns.          |
|    2 | `antidrift/no-unsafe-deserialize`       | stable                         | monitor                            | Sudocode, Cloudflare Agents       | Chaski, Codebase Atlas, Sudocode, Cloudflare Agents | Parse-at-edge is core scope; type-aware clean breadth exists, drift replicates across two repos, guarded `MessageEvent.data` parses are handled, Claude advisory completed, and type-aware fail-open behavior now reports a config error.                                           |
|    3 | `antidrift/no-redundant-zod-parse`      | stable                         | monitor                            | Chaski, Murderbox                 | Chaski, Codebase Atlas, Murderbox                   | Parse-at-edge/reparse discipline is original scope; helper-result reparses now cover assigned, inline awaited, and sync call results, while schema-contract assertions and nested first-boundary schema pipelines stay clean.                                                       |
|    4 | `antidrift/no-raw-fetch-in-component`   | stable                         | monitor                            | Chaski, Codebase Atlas, Murderbox | Chaski, Sudocode, Murderbox                         | Scope is fetch-specific; `globalThis.fetch` is covered, Chaski/Atlas/Murderbox drift replicates, and clean controls cover API/client modules plus query/refetch UI usage. Broader raw transport ownership is a separate future rule if non-fetch evidence appears.                  |
|    5 | `antidrift/require-effect-deps`         | stable                         | monitor                            | Chaski, Claude Code Source        | Chaski, Codebase Atlas, Sudocode, Murderbox         | Exhaustive-deps misses the no-array case and external drift now replicates it; intentional every-render effects use a rule-specific disable with a required reason, backed by maintained disable-description linting.                                                               |
|    6 | `antidrift/no-sql-string-concat`        | needs remaining SQL classification | continue                           | Chaski                            | Chaski, Codebase Atlas, Sudocode, Cloudflare Agents | Injection-boundary policy remains valuable; `pnpm policy:benchmark-sql-queries` reports 10 custom findings and 0 SonarJS findings. Static fragment arrays, parameterized SQL tags, typed `ORDER BY`, and static column maps now stay clean; dynamic object-key columns and non-allowlisted table names remain unresolved. |
|    7 | `antidrift/no-trivial-selector-wrapper` | adapter convention documented  | continue                           | Chaski, Codebase Atlas            | Chaski, Codebase Atlas                              | Structural inference-appeasement wrappers are core type-contract scope; Codebase Atlas now supplies a non-name-gated `fullExcerpt(file) { return file.source; }` drift gate. One Murderbox adapter callback is documented, but repeated pressure has not appeared.                  |
|    8 | `antidrift/no-async-array-method`       | needs drift replication        | defer unless another drift appears | Sudocode                          | Chaski, Codebase Atlas, Sudocode                    | Deterministic and narrow, but clean breadth plus only one test-file drift makes it lower leverage than core type/validation/security rules.                                                                                                                                         |
|    9 | `antidrift/no-status-literal-in-type`   | needs external clean and drift | defer                              | Chaski                            | Chaski                                              | Registry-backed domain vocabulary is useful, but status literal replacement can wait until another configured status-owner repo produces real drift.                                                                                                                                |
|   10 | `antidrift/no-unsafe-cast-chain`        | needs external clean and drift | defer behind `no-appeasement-cast` | Chaski                            | Chaski                                              | The broader appeasement-cast rule covers the higher-value type-escape surface; keep this narrow tunnel rule, but do not prioritize stable promotion.                                                                                                                                |

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

This slice resolved the effect escape convention and rechecked the selector and SQL promotion blockers with real-program scans. The effect rule is stable. The selector rule stays structural because adapter pressure has only one strong real case. The SQL rule stays unpromoted because a widened scan still has unresolved findings around dynamic SQL identifier construction.

1. Classify or remediate the remaining SQL findings before promotion: dynamic `Object.keys(updates)` column lists, non-allowlisted table-name query assembly, and test/browser-evaluation SQL strings need explicit clean/drift decisions.
2. Keep `antidrift/no-trivial-selector-wrapper` structural until repeated adapter-callback pressure appears in real repositories.
