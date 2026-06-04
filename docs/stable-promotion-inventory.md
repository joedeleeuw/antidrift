# Stable Promotion Inventory

This is the promotion ledger for the implemented rule set. It is stricter than `ready`: a stable rule needs at least two independent real repositories with non-test-created drift replication, clean controls, zero known false positives, zero known false negatives, no unresolved production concerns, and a grounded Claude advisory review.

This table is derived from `policy/registries/rules.yaml`, `tooling/antidrift/src/policy/chaski-corpus.mjs`, and `tooling/antidrift/src/policy/external-corpus.mjs`. Reduced fixtures do not count.

## Stack Rank

| Rank | Rule                                    | Promotion bucket               | Utility lens                       | Drift repos                      | Clean repos                                         | Why                                                                                                                                                                                                                                                                        |
| ---: | --------------------------------------- | ------------------------------ | ---------------------------------- | -------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `antidrift/no-appeasement-cast`         | remediation-patterns-proven    | pause remediation                  | Chaski, Codebase Atlas, Sudocode | Chaski, Codebase Atlas, antidrift                   | Type-escape hatches are core scope; upstream benchmark proved `@typescript-eslint/no-unsafe-type-assertion` is a much broader superset. Copy-backed repairs now prove caught-error, serialized-storage, schema-backed object-contract, and third-party bag guard patterns. |
|    2 | `antidrift/no-unsafe-deserialize`       | stable                         | monitor                            | Sudocode, Cloudflare Agents      | Chaski, Codebase Atlas, Sudocode, Cloudflare Agents | Parse-at-edge is core scope; type-aware clean breadth exists, drift replicates across two repos, guarded `MessageEvent.data` parses are handled, Claude advisory completed, and type-aware fail-open behavior now reports a config error.                              |
|    3 | `antidrift/no-redundant-zod-parse`      | test assertion scope decision  | continue                           | Chaski, Murderbox                | Chaski, Codebase Atlas, Murderbox                   | Parse-at-edge/reparse discipline is original scope; external production drift exists, but typed schema-contract assertions in tests need a policy decision.                                                                                                                |
|    4 | `antidrift/no-raw-fetch-in-component`   | scope decision                 | continue if broadened              | Chaski, Codebase Atlas           | Chaski, Sudocode                                    | Component-owned transport drift replicated, but stable depends on whether this remains fetch-specific or becomes a registry-backed raw transport boundary rule.                                                                                                            |
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

The `antidrift/no-unsafe-deserialize` slice now has second-repo drift replication through Cloudflare Agents and clean controls in Chaski, Codebase Atlas, Sudocode, and Cloudflare Agents. The guarded-`any` concern is resolved, Claude advisory review completed on June 4, 2026, and the type-aware parserServices guard is implemented. The next useful work is the `antidrift/no-redundant-zod-parse` test assertion scope decision.

1. Keep Cloudflare `examples/assistant/src/server.ts`, `packages/voice/src/text-stream.ts`, and `voice-providers/twilio/src/index.ts` as the external drift/control gate for future regressions.
2. For `no-redundant-zod-parse`, decide whether typed schema-contract assertions in tests are in scope or should get an assertion-context exception.
3. Run grounded advisory review for `no-redundant-zod-parse` after the scope decision is implemented.
