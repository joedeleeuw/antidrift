# Rule Status Registry

`policy/registries/rules.yaml` is the rule status registry. It tracks each active `antidrift/*` rule, retired rule, and research candidate with its status, signal, corpus repositories, production concerns, and next action.

Each active rule entry also declares `examples.flags` and `examples.allows` beside its registration. `pnpm policy:check-registries` fails when an active rule is missing either side, so rule definitions always carry a short positive and negative example.

Each active rule also declares an `external` ownership block:

```yaml
external:
  state: partial-overlap
  support: high
  candidates: ["@typescript-eslint/no-unsafe-type-assertion"]
  decision: own-antidrift
  whyThisState: "The upstream rule catches this family, but it is broader than the local policy."
  whyNotOtherState: "Not equivalent because real clean controls are also reported upstream."
```

The two `why*` fields are deliberately required. They are the escape hatch against cognitive drift: a rule cannot simply claim "ecosystem overlap" without explaining why that state is correct and why the closest alternative state is wrong.

`docs/rule-equivalence-audit.md` is the companion ownership audit. It tracks whether a custom rule should be retired in favor of a maintained ESLint, `typescript-eslint`, plugin, or generated core-config replacement.

This file is the readable index. Update the YAML registry first, then keep this table aligned.

## Status Meanings

| Status                 | Meaning                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                | Implemented, enabled, and backed by at least one real drift and clean assertion under the current local gate.                          |
| `under-proven`         | Implemented, but missing enough real drift or clean evidence to trust promotion.                                                       |
| `false-positive-prone` | Implemented, but real corpus evidence or review found an overbroad branch or unstable signal.                                          |
| `ecosystem-covered`    | Existing ecosystem rule or plugin covers the behavior well enough; do not implement a custom antidrift rule unless a real gap remains. |
| `retired`              | Removed from active rule surface because real code showed the signal was not deterministic enough.                                     |
| `research`             | Not implemented; requires ecosystem review and real corpus evidence before entering scope.                                             |

`ready` is not the same as stable. Stable promotion requires multiple independent repository replications that were not created for the rule, zero known false positives, zero known false negatives, no unresolved production concerns, and a grounded Claude Opus 4.8 advisory review.

## Severity Discipline

Rule maturity constrains configured severity. `under-proven`, `false-positive-prone`, and `research` rules must not be configured as blocking. Heuristic signals such as `token-overlap` and configurable name groups must also stay non-blocking until multiple real inventories show low noise.

`pnpm policy:check-rule-surface` enforces this against `policy/registries/rules.yaml`. In this repository, both `warn` and `error` count as blocking because the lint gate runs with zero-warning discipline. Implemented rules can remain registered in the shared config as `off` while they collect evidence.

Current default-off custom rules:

- `antidrift/no-cast-to-branded`: under-proven until real branded-value forgery appears in corpus code.
- `antidrift/no-role-literal-in-type`: under-proven until a real role-union redeclaration is accepted.
- `antidrift/no-obvious-comment`: token-overlap heuristic; useful for review inventory, not yet safe as a blocker.
- `antidrift/no-status-triplet-state`: configurable name-group heuristic; needs low-noise frontend inventories before blocking.

## External Ownership States

These states answer whether `antidrift` should own code for the rule or defer to a maintained ESLint ecosystem rule/config.

| External state       | Meaning                                                                                           | Example decision                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `equivalent`         | A maintained ecosystem rule covers the same behavior and ambition.                                | Use upstream and retire custom code.                                            |
| `broader-upstream`   | A maintained rule catches the target but also reports a materially larger policy surface.         | Keep custom, or stage upstream separately after inventory.                      |
| `narrower-upstream`  | A maintained rule catches a subset but misses the local ambition.                                 | Use both only if the messages remain distinct.                                  |
| `partial-overlap`    | Existing rules cover nearby behavior but not the exact failure mode.                              | Keep custom and document the gap.                                               |
| `config-replacement` | Core ESLint config could express the behavior, often through generated selectors or restrictions. | Prefer config when it stays readable; keep code when context/exceptions matter. |
| `net-antidrift`      | No supported equivalent was found for the scoped behavior.                                        | Own custom only with real corpus evidence.                                      |

`support` records how much confidence we have in the external candidate itself: `none`, `low`, `medium`, or `high`. Support is not equivalence. A highly supported rule can still be the wrong replacement if its scope is broader, narrower, or aimed at a different failure mode.

## Signal Definitions

Use these labels literally. A rule should not claim a deeper signal than it actually uses.

| Signal                      | Declarative definition                                                                                                                                                               | Good examples                                                                                   | Not enough for                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `deterministic AST`         | The source syntax itself is the construction pattern being banned. The rule does not need to infer ownership, trust, or semantic intent.                                             | `as unknown as T`; `.forEach(async () => ...)`; `useEffect(fn)` with no dependency array.       | Proving a type guard is sound; proving a domain model is canonical; proving data is untrusted. |
| `class-string`              | The string literal or extracted class token is the policy surface.                                                                                                                   | Raw Tailwind color utilities; hover translate utilities on pointer targets.                     | Inferring design intent from arbitrary component names.                                        |
| `source-comment`            | The comment text itself is the policy surface.                                                                                                                                       | Bare `eslint-disable`; `@ts-ignore` without a reason.                                           | Proving the disabled rule was safe.                                                            |
| `scope-binding`             | The rule follows local bindings inside a file so it reports the thing actually referenced, not a name coincidence.                                                                   | React state setter coupling in one handler.                                                     | Cross-file ownership or type identity.                                                         |
| `registry plus AST context` | A registry supplies repo facts, and AST context limits where those facts apply.                                                                                                      | Status or role literal type redeclarations.                                                     | Whole-model structural equivalence without TypeChecker support.                                |
| `TypeChecker`               | The rule depends on TypeScript's inferred types, symbol identity, assignability, or parser services.                                                                                 | `any`/`unknown` JSON parse; cast-to-branded; installed package and generated-source type forks. | Rules that must work in non-type-aware linting.                                                |
| `import-graph`              | The rule reasons over file-to-file import edges.                                                                                                                                     | Relative import cycles.                                                                         | Runtime call graphs or dataflow.                                                               |
| `heuristic`                 | The rule intentionally uses an incomplete signal because no deterministic signal is available yet. It should be warning-level or under-proven until real inventories show low noise. | Status triplets by configurable state names; obvious comments.                                  | Stable promotion without multiple clean inventories.                                           |

Syntax should be a violation only when the construction pattern is the policy. If a rule is trying to prove meaning, ownership, trust, or type authority, it needs a stronger signal than syntax.

## Investigation Flow

Start investigation before code:

1. Create or update a reference doc under `docs/rule-investigations/`.
2. Check existing ESLint, `typescript-eslint`, and relevant plugin coverage.
3. Update `docs/rule-equivalence-audit.md` when the rule is active, replaceable, or net-new.
4. Kick off a read-only Claude Opus 4.8 advisory review using `docs/claude-rule-review-protocol.md`.
5. Mark the candidate `ecosystem-covered` when an existing rule is sufficient.
6. Keep the candidate `research` until a real drift file and clean control prove a custom rule is needed.

## Active Rule Table

| Rule                                              |         Status | Stable | Signal                                                    | External                               | Next action                                                                                                                                   |
| ------------------------------------------------- | -------------: | -----: | --------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-appeasement-cast`                   |        `ready` |     no | TypeChecker                                               | `broader-upstream` / `own-antidrift`   | Copy-backed repair patterns are proven; pause copy-only remediation and rerun broad inventory after real consumer cleanup.                    |
| `antidrift/no-async-array-method`                 |        `ready` |     no | AST                                                       | `partial-overlap` / `own-antidrift`    | Find a second independent real drift instance, or document an explicit one-repo evidence exception before stable promotion.                   |
| `antidrift/no-cast-to-branded`                    | `under-proven` |     no | TypeChecker                                               | `broader-upstream` / `own-antidrift`   | Wait for a real forged brand cast and decide whether Zod branded targets are in scope.                                                        |
| `antidrift/no-coupled-state-setters`              |        `ready` |     no | scope-binding                                             | `net-antidrift` / `own-antidrift`      | Classify inventory findings before stable promotion.                                                                                          |
| `antidrift/no-defensive-shape-probing`            |        `ready` |     no | TypeChecker plus AST shape                                | `net-antidrift` / `own-antidrift`      | Seek a second real drift repository before stable promotion.                                                                                  |
| `antidrift/no-hover-translate-card`               |        `ready` |     no | AST string literal extraction                             | `config-replacement` / `own-antidrift` | Stable promotion requires inventory classification across another UI repo.                                                                    |
| `antidrift/no-inline-structural-type-at-use-site` |        `ready` |     no | AST                                                       | `config-replacement` / `own-antidrift` | Seek independent repo replication before stable promotion.                                                                                    |
| `antidrift/no-nullable-positional-tuple`          |        `ready` |     no | deterministic AST                                         | `net-antidrift` / `own-antidrift`      | Seek another real nullable positional tuple and clean tuple-control replication before stable promotion.                                      |
| `antidrift/no-obvious-comment`                    |        `ready` |     no | token-overlap                                             | `partial-overlap` / `own-antidrift`    | Keep as lower-confidence until another repo inventory shows low false positives.                                                              |
| `antidrift/no-raw-fetch-in-component`             |        `ready` |     no | import-scope plus AST                                     | `config-replacement` / `own-antidrift` | Decide narrow fetch-specific scope versus registry-backed raw transport boundary before stable promotion.                                     |
| `antidrift/no-raw-tailwind-color`                 |        `ready` |     no | class-string                                              | `config-replacement` / `own-antidrift` | Classify inventory findings before stable promotion.                                                                                          |
| `antidrift/no-redundant-zod-parse`                |        `ready` |     no | TypeChecker plus schema provenance                        | `net-antidrift` / `own-antidrift`      | Decide test assertion scope, then run grounded advisory review before stable promotion.                                                       |
| `antidrift/no-role-literal-in-type`               | `under-proven` |     no | registry plus AST context                                 | `config-replacement` / `own-antidrift` | Do not promote until a real role union redeclaration is found.                                                                                |
| `antidrift/no-sql-string-concat`                  |        `ready` |     no | AST string construction                                   | `partial-overlap` / `own-antidrift`    | SonarJS benchmark found 0 upstream findings against 12 custom findings; seek independent replication with parameterized-query clean controls. |
| `antidrift/no-status-literal-in-type`             |        `ready` |     no | registry plus AST context                                 | `config-replacement` / `own-antidrift` | Seek independent status-fork replication before stable promotion.                                                                             |
| `antidrift/no-status-triplet-state`               |        `ready` |     no | configurable name groups plus React state shape           | `net-antidrift` / `own-antidrift`      | Keep configurable and classify another frontend repo inventory.                                                                               |
| `antidrift/no-structural-type-fork`               |        `ready` |     no | TypeChecker structural comparison plus generated registry | `net-antidrift` / `own-antidrift`      | Seek independent generated-source or installed-package fork replication before stable promotion.                                              |
| `antidrift/no-canonical-model-fork`               |        `ready` |     no | TypeChecker plus domain registry                          | `net-antidrift` / `own-antidrift`      | Run another repo inventory with configured domain owners before stable promotion.                                                             |
| `antidrift/no-trivial-selector-wrapper`           |        `ready` |     no | AST structural return shape                               | `net-antidrift` / `own-antidrift`      | Seek independent non-name-gated selector-wrapper replication before stable promotion.                                                         |
| `antidrift/no-underchecked-type-predicate`        |        `ready` |     no | TypeChecker plus AST/control-flow checks                  | `net-antidrift` / `own-antidrift`      | Seek another broad-input underchecked predicate drift case before stable promotion.                                                           |
| `antidrift/no-unsafe-cast-chain`                  |        `ready` |     no | AST cast chain                                            | `broader-upstream` / `own-antidrift`   | Seek independent cast-tunnel replication before stable promotion.                                                                             |
| `antidrift/no-unsafe-deserialize`                 |        `ready` |     no | TypeChecker                                               | `partial-overlap` / `own-antidrift`    | Resolve the guarded-`any` narrowing concern for typeof-string `MessageEvent.data` before stable promotion.                                    |
| `antidrift/require-authz-check`                   |        `ready` |     no | AST control-flow plus registry                            | `net-antidrift` / `own-antidrift`      | Keep tRPC authorization as a separate scoped decision.                                                                                        |
| `antidrift/require-effect-deps`                   |        `ready` |     no | import binding plus AST                                   | `partial-overlap` / `own-antidrift`    | Seek independent missing-dependency-array replication before stable promotion.                                                                |

## Research Candidates

| Candidate                                      |              Status | Signal                           | Entry condition                                                                                                                                    |
| ---------------------------------------------- | ------------------: | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystem/discriminated-union-exhaustiveness` | `ecosystem-covered` | TypeChecker                      | Prefer `@typescript-eslint/switch-exhaustiveness-check` and related type-aware rules before custom work.                                           |
| `ecosystem/import-cycle`                       | `ecosystem-covered` | import-graph                     | Covered by `import-x/no-cycle` in the shared ESLint config; keep custom graph traversal retired.                                                   |
| `ecosystem/disable-comment-description`        | `ecosystem-covered` | source-comment                   | Covered by `@eslint-community/eslint-comments/require-description` and `@typescript-eslint/ban-ts-comment` in the shared ESLint config.            |
| `ecosystem/gateway-restricted-imports`         | `ecosystem-covered` | registry plus core ESLint config | Covered by generated `no-restricted-imports` patterns and wrapper-file overrides in the shared ESLint config.                                      |
| `ecosystem/vitest-test-integrity`              | `ecosystem-covered` | maintained ESLint plugin         | Covered by `@vitest/eslint-plugin` for focused tests, disabled tests, conditional expects/tests, standalone expects, and missing assertion checks. |
| `ecosystem/react-hooks-compiler`               | `ecosystem-covered` | maintained ESLint plugin         | Covered by `eslint-plugin-react-hooks` recommended-latest plus explicit `react-hooks/no-deriving-state-in-effects`.                                |
| `ecosystem/sonar-sql-queries`                  | `ecosystem-covered` | maintained ESLint plugin         | Covered by `sonarjs/sql-queries`, but the local benchmark currently reports 0 findings against 12 custom SQL findings.                             |

## Retired Rules

| Rule                                               | Reason                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-cycle`                               | Replaced by maintained import graph coverage through `import-x/no-cycle`.                                                                                              |
| `antidrift/no-inline-disable-without-ticket`       | Replaced by maintained ESLint directive description coverage through `@eslint-community/eslint-comments/require-description` plus `@typescript-eslint/ban-ts-comment`. |
| `antidrift/no-sdk-direct-use`                      | Replaced by generated ESLint core `no-restricted-imports` rules with wrapper-file overrides from `policy/registries/gateways.yaml`.                                    |
| `antidrift/no-explicit-return-type-private-helper` | Real Chaski code showed explicit private helper return types are often legitimate contracts.                                                                           |
| `antidrift/no-silent-catch`                        | Retired after utility review; maintained `no-empty`, `no-console`, and SonarJS catch rules cover enough of the low-value surface.                                      |

## Advisory Review

Use `docs/claude-rule-review-protocol.md` before stable promotion or when a rule's signal is disputed. The review must be read-only, grounded in current code, written to `reports/`, and treated as advisory evidence only.
