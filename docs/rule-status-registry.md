# Rule Status Registry

`policy/registries/rules.yaml` is the rule status registry. It tracks each active `antidrift/*` rule, retired rule, research candidate, and policy-scoped rule review with its status, signal, corpus repositories, production concerns, and next action.

Each active rule entry also declares `examples.flags` and `examples.allows` beside its registration. `pnpm policy:check-registries` fails when an active rule is missing either side, so rule definitions always carry a short positive and negative example.

Active rows can also split evidence into `proven`, `unproven`, and `openReviewConcerns`. Use `proven` for accepted real-program drift or clean controls, `unproven` for remaining blockers before stable promotion, and `openReviewConcerns` for adversarial-review notes that need follow-up. `pnpm policy:check-registries` validates these as string lists when present.

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

`policy/registries/rules.yaml` also registers rule families. The current type-contract family is documented in `docs/rule-family-type-contract-authority.md`; it groups the cast, parse, predicate, selector, duplication, and typed-delegation subsets so future work can draw scope boundaries before adding rules.

The `policyRuleReviews` section closes the broader policy surface. Every rule ID named in `policy/agent-guardrails.yaml` must have a row there, even when it is not a custom ESLint rule. `pnpm policy:check-registries` fails when a policy ID is missing, when the registry invents an extra policy review, or when an `active-custom` review points at a non-active `antidrift/*` rule.

Each rule is judged on its own merits through a senior JavaScript/TypeScript tooling lens. If an ecosystem rule covers the same behavior, the custom rule becomes an elimination candidate. If a signal is too broad or symptomatic, the next action is to reformulate the failure mode until the rule has a narrow construction pattern. If a rule's value is unclear, first recover the original local complaint from the current session, handoff docs, reports, or available Codex memory; then test that complaint against real code and ecosystem rules. If the value still cannot be stated clearly, do not implement it; collect at least three close ecosystem/readme references or practitioner writeups and keep the candidate in `research` until the "why" is defensible.

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

## Policy Rule Review States

`policyRuleReviews` answers a different question than the active custom-rule table: "what is the disposition of every rule ID in the generated policy scope?" The current policy source declares 60 rule IDs.

| Review status       | Count | Meaning                                                                                      |
| ------------------- | ----: | -------------------------------------------------------------------------------------------- |
| `active-custom`     |    18 | Implemented by an active `antidrift/*` rule.                                                 |
| `ecosystem-covered` |    10 | Covered by maintained ESLint, `typescript-eslint`, React, Vitest, SonarJS, or imports rules. |
| `generated-config`  |     2 | Covered by registry-generated core ESLint configuration.                                     |
| `hook-covered`      |     4 | Covered by generated agent lifecycle hooks.                                                  |
| `policy-script`     |     3 | Covered by an antidrift policy command or report generator.                                  |
| `delegated`         |     2 | Delegated to SonarQube or another external gate.                                             |
| `merged`            |     1 | Merged into another reviewed policy rule.                                                    |
| `research`          |    10 | Reviewed as plausible, but not implemented until real evidence and ecosystem checks exist.   |
| `spec-only`         |    10 | Documented policy with no deterministic enforcement in the current package scope.            |
| `retired`           |     0 | Removed from active policy enforcement after review.                                         |

Every review row must include `coverage`, `reason`, and `nextAction`. Rows that defer to an ecosystem, generated-config, hook, policy-script, delegated, or retired path must also name a `replacement`. `active-custom` rows must name the active `antidriftRule`.

## Decision Locks

Some decisions are intentionally harder to reopen than ordinary registry rows. `policy/registries/rules.yaml` has a `decisionLocks` section for custom rules that were retired and candidates that were judged ecosystem-covered. `pnpm policy:check-registries` validates those locks against a hardcoded list in `tooling/antidrift/src/policy/check-registries.mjs`.

That means a shot-down rule cannot quietly return by moving it from `retiredRules` or `researchCandidates` into the active `rules` table. Reopening one requires changing the checker and tests, which should happen only as explicit policy work backed by new real-code evidence.

Rule-family subsets may reference a locked decision only as historical evidence, and must declare `historical: true`. That keeps the old lesson searchable without making the subset look like active implementation scope.

Current locked decisions include:

- retired custom rules: `antidrift/no-cycle`, `antidrift/no-inline-disable-without-ticket`, `antidrift/no-sdk-direct-use`, `antidrift/no-explicit-return-type-private-helper`, `antidrift/no-silent-catch`, `antidrift/no-thin-typed-factory-wrapper`, `antidrift/no-obvious-comment`, `antidrift/no-role-literal-in-type`, `antidrift/no-cast-to-branded`, and `antidrift/no-unsafe-cast-chain`
- ecosystem-covered candidates: discriminated-union exhaustiveness, import cycles, disable-comment descriptions, gateway restricted imports, Vitest test integrity, React Hooks compiler coverage, and SonarJS SQL query coverage

## Severity Discipline

Rule maturity constrains configured severity. `under-proven`, `false-positive-prone`, and `research` rules must not be configured as blocking. Default-off inventory signals, such as the current React resource-state triplet detector, must also stay non-blocking until they have a stronger behavioral signal and multiple real inventories show low noise.

`pnpm policy:check-rule-surface` enforces this against `policy/registries/rules.yaml`. In this repository, both `warn` and `error` count as blocking because the lint gate runs with zero-warning discipline. Implemented rules can remain registered in the shared config as `off` while they collect evidence.

Current default-off custom rules:

- `antidrift/no-status-triplet-state`: React `useState` resource-lifecycle inventory signal; needs a derivability/cohesion detector and low-noise frontend inventories before blocking.

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
| `TypeChecker`               | The rule depends on TypeScript's inferred types, symbol identity, assignability, or parser services.                                                                                 | `any`/`unknown` JSON parse; appeasement casts; installed package and generated-source type forks. | Rules that must work in non-type-aware linting.                                                |
| `import-graph`              | The rule reasons over file-to-file import edges.                                                                                                                                     | Relative import cycles.                                                                         | Runtime call graphs or dataflow.                                                               |
| `heuristic`                 | The rule intentionally uses an incomplete signal because no deterministic signal is available yet. It should be warning-level or under-proven until real inventories show low noise. | Status triplets by configurable state names; obvious comments.                                  | Stable promotion without multiple clean inventories.                                           |

Syntax should be a violation only when the construction pattern is the policy. If a rule is trying to prove meaning, ownership, trust, or type authority, it needs a stronger signal than syntax.

## Investigation Flow

Start investigation before code:

1. Create or update a reference doc under `docs/rule-investigations/`.
2. Recover the original complaint from the current session, local handoff/report docs, or available Codex memory. Summarize it as a concrete failure mode, not as a quote dump.
3. Check existing ESLint, `typescript-eslint`, and relevant plugin coverage.
4. Update `docs/rule-equivalence-audit.md` when the rule is active, replaceable, or net-new.
5. Kick off a read-only Claude Opus 4.8 advisory review using `docs/claude-rule-review-protocol.md`.
6. Mark the candidate `ecosystem-covered` when an existing rule is sufficient.
7. If the "why" is still unclear, find three close ecosystem rules, plugin readmes, or practitioner references and summarize why each is equivalent, broader, narrower, or only adjacent.
8. Keep the candidate `research` until a real drift file and clean control prove a custom rule is needed.

## Active Rule Table

| Rule                                              |         Status | Stable | Signal                                                                                                | External                               | Next action                                                                                                                                                                        |
| ------------------------------------------------- | -------------: | -----: | ----------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-appeasement-cast`                   |        `ready` |     no | TypeChecker                                                                                           | `broader-upstream` / `own-antidrift`   | Copy-backed repair patterns are proven; pause copy-only remediation and rerun broad inventory after real consumer cleanup.                                                         |
| `antidrift/no-async-array-method`                 |        `ready` |     no | AST                                                                                                   | `partial-overlap` / `own-antidrift`    | Find a second independent real drift instance, or document an explicit one-repo evidence exception before stable promotion.                                                        |
| `antidrift/no-coupled-state-setters`              |        `ready` |     no | scope-binding                                                                                         | `net-antidrift` / `own-antidrift`      | Classify inventory findings before stable promotion.                                                                                                                               |
| `antidrift/no-defensive-shape-probing`            |        `ready` |     no | TypeChecker plus AST shape                                                                            | `partial-overlap` / `own-antidrift`    | Current any-typed drift overlaps upstream unsafe rules on member reads; 2026-06-09 syntax sweep added clean controls but no second drift.                                          |
| `antidrift/no-hover-translate-card`               |        `ready` |     no | AST string literal extraction                                                                         | `config-replacement` / `own-antidrift` | Stable promotion requires inventory classification across another UI repo.                                                                                                         |
| `antidrift/no-inline-structural-type-at-use-site` |        `ready` |     no | AST                                                                                                   | `config-replacement` / `own-antidrift` | Seek independent repo replication before stable promotion.                                                                                                                         |
| `antidrift/no-nullable-positional-tuple`          |        `ready` |     no | deterministic AST                                                                                     | `net-antidrift` / `own-antidrift`      | Seek another real nullable positional tuple and clean tuple-control replication before stable promotion.                                                                           |
| `antidrift/no-raw-fetch-in-component`             |        `ready` |    yes | import-scope plus AST                                                                                 | `config-replacement` / `own-antidrift` | Stable; monitor for real aliased/destructured fetch evidence and keep broader raw transport as a separate future rule.                                                             |
| `antidrift/no-raw-tailwind-color`                 |        `ready` |     no | class-string                                                                                          | `config-replacement` / `own-antidrift` | Classify inventory findings before stable promotion.                                                                                                                               |
| `antidrift/no-redundant-zod-parse`                |        `ready` |    yes | TypeChecker plus schema provenance                                                                    | `net-antidrift` / `own-antidrift`      | Stable; monitor for first-boundary schema pipelines that need additional clean exclusions.                                                                                         |
| `antidrift/no-sql-string-concat`                  |        `ready` |     no | SQL keyword/context AST plus scope-binding guard control-flow plus TypeChecker imported-escaper and configured safe-identifier-member proof | `partial-overlap` / `own-antidrift`    | Decide parser-services-only broad inventory policy; safe identifier controls require parser services and must not be replaced with name-only exemptions. |
| `antidrift/no-status-literal-in-type`             |        `ready` |     no | registry plus AST context                                                                             | `config-replacement` / `own-antidrift` | Seek independent status-fork replication before stable promotion.                                                                                                                  |
| `antidrift/no-status-triplet-state`               |        `ready` |     no | React `useState` name groups for resource-lifecycle inventory                                         | `net-antidrift` / `own-antidrift`      | Do not block until the rule proves derivability/cohesion behavior and another frontend inventory is low-noise.                                                                     |
| `antidrift/no-structural-type-fork`               |        `ready` |     no | TypeChecker structural comparison plus generated registry                                             | `net-antidrift` / `own-antidrift`      | Seek independent generated-source or installed-package fork replication before stable promotion.                                                                                   |
| `antidrift/no-canonical-model-fork`               |        `ready` |     no | TypeChecker plus domain registry                                                                      | `net-antidrift` / `own-antidrift`      | Run another repo inventory with configured domain owners before stable promotion.                                                                                                  |
| `antidrift/no-trivial-selector-wrapper`           |        `ready` |    yes | AST structural return shape                                                                           | `net-antidrift` / `own-antidrift`      | Stable; adapter callbacks can stay named and stable, but bare member-return helpers should rely on inferred return types instead of explicit annotations.                          |
| `antidrift/no-underchecked-type-predicate`        |        `ready` |     no | TypeChecker plus AST/control-flow checks                                                              | `net-antidrift` / `own-antidrift`      | Sudocode added clean controls; Opencode has a non-evaluable UI drift candidate blocked by missing tsconfig deps; still needs a second evaluable drift.                             |
| `antidrift/no-unsafe-deserialize`                 |        `ready` |    yes | TypeChecker plus local string-boundary control flow                                                   | `partial-overlap` / `own-antidrift`    | Stable for parse-input safety; parse-output contract assertions are owned by the cast-family rules.                                                                                |
| `antidrift/require-authz-check`                   |        `ready` |     no | AST control-flow plus registry                                                                        | `net-antidrift` / `own-antidrift`      | Sudocode now proves the handler-local Express route-param shape; middleware-aware Express dominance and tRPC procedure authorization remain separate scopes.                       |
| `antidrift/require-effect-deps`                   |        `ready` |    yes | import binding plus AST                                                                               | `partial-overlap` / `own-antidrift`    | Stable; intentional every-render effects use a rule-specific disable with a required reason.                                                                                       |

## Research Candidates

| Candidate                                      |              Status | Signal                                                                          | Entry condition                                                                                                                                    |
| ---------------------------------------------- | ------------------: | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecosystem/discriminated-union-exhaustiveness` | `ecosystem-covered` | TypeChecker                                                                     | Prefer `@typescript-eslint/switch-exhaustiveness-check` and related type-aware rules before custom work.                                           |
| `ecosystem/import-cycle`                       | `ecosystem-covered` | import-graph                                                                    | Covered by `import-x/no-cycle` in the shared ESLint config; keep custom graph traversal retired.                                                   |
| `ecosystem/disable-comment-description`        | `ecosystem-covered` | source-comment                                                                  | Covered by `@eslint-community/eslint-comments/require-description` and `@typescript-eslint/ban-ts-comment` in the shared ESLint config.            |
| `ecosystem/gateway-restricted-imports`         | `ecosystem-covered` | registry plus core ESLint config                                                | Covered by generated `no-restricted-imports` patterns and wrapper-file overrides in the shared ESLint config.                                      |
| `ecosystem/vitest-test-integrity`              | `ecosystem-covered` | maintained ESLint plugin                                                        | Covered by `@vitest/eslint-plugin` for focused tests, disabled tests, conditional expects/tests, standalone expects, and missing assertion checks. |
| `ecosystem/react-hooks-compiler`               | `ecosystem-covered` | maintained ESLint plugin                                                        | Covered by `eslint-plugin-react-hooks` recommended-latest plus explicit `react-hooks/no-deriving-state-in-effects`.                                |
| `ecosystem/sonar-sql-queries`                  | `ecosystem-covered` | maintained ESLint plugin                                                        | Covered by `sonarjs/sql-queries`, but the local benchmark currently reports 0 findings against 16 custom SQL findings.                             |
| `antidrift/no-same-schema-recertification`     |          `research` | TypeChecker plus schema-output assignability and refinement-free override proof | Do not implement; classify Codebase Atlas roundtrip parse anchors first, then drop unless a second repo proves remediated value.                   |

## Retired Rules

| Rule                                               | Reason                                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-cycle`                               | Replaced by maintained import graph coverage through `import-x/no-cycle`.                                                                                                                          |
| `antidrift/no-inline-disable-without-ticket`       | Replaced by maintained ESLint directive description coverage through `@eslint-community/eslint-comments/require-description` plus `@typescript-eslint/ban-ts-comment`.                             |
| `antidrift/no-sdk-direct-use`                      | Replaced by generated ESLint core `no-restricted-imports` rules with wrapper-file overrides from `policy/registries/gateways.yaml`.                                                                |
| `antidrift/no-explicit-return-type-private-helper` | Real Chaski code showed explicit private helper return types are often legitimate contracts.                                                                                                       |
| `antidrift/no-silent-catch`                        | Retired after utility review; maintained `no-empty`, `no-console`, and SonarJS catch rules cover enough of the low-value surface.                                                                  |
| `antidrift/no-thin-typed-factory-wrapper`          | Retired/dropped after read-only audit found no real non-test exact-forward internal drift; broad typed-constructor wrappers and exported facades are clean controls with high false-positive risk. |
| `antidrift/no-obvious-comment`                     | Token-overlap comment restatement produced review-style noise and did not justify custom lint ownership.                                                                                          |
| `antidrift/no-role-literal-in-type`                | Role words are too generic without stronger canonical model context, and no accepted real role-union redeclaration was found.                                                                      |
| `antidrift/no-cast-to-branded`                     | No real non-test branded cast forgery was found, and the package-specific brand marker had no real adoption.                                                                                       |
| `antidrift/no-unsafe-cast-chain`                   | Replaced by maintained `@typescript-eslint/no-unsafe-type-assertion` coverage for double-cast tunnels; `no-appeasement-cast` owns the narrower source-boundary authority policy.                  |

## Advisory Review

Use `docs/claude-rule-review-protocol.md` before stable promotion or when a rule's signal is disputed. The review must be read-only, grounded in current code, written to `reports/`, and treated as advisory evidence only.
