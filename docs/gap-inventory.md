# Gap Inventory

Last updated: 2026-06-09.

This is the synthesized gap surface for the current antidrift repository. It does not replace the source ledgers:

- `policy/registries/rules.yaml` owns rule status, examples, external ownership, concerns, and next action.
- `docs/rule-status-registry.md` is the readable rule table.
- `docs/policy-coverage.md` owns broad policy-cluster coverage.
- `docs/stable-promotion-inventory.md` owns stable-promotion blockers.
- `docs/real-corpus-validation.md` owns real-program evidence.
- `docs/lint-rule-parity.md` owns retired Oxlint parity.

## Current Counts

Active custom rules in the registry: 24.
Policy-scoped rule IDs reviewed in `policyRuleReviews`: 63.

| State                      | Count | Meaning                                                                                |
| -------------------------- | ----: | -------------------------------------------------------------------------------------- |
| Stable                     |     5 | Ready, independently replicated enough for stable treatment.                           |
| Ready but not stable       |    17 | Implemented and enabled, but evidence, inventory, or advisory gates remain.            |
| Under-proven               |     2 | Implemented but default-off because real drift or clean evidence is not strong enough. |
| Retired Oxlint parity gaps |     0 | The former Oxlint baseline has ESLint replacements or explicit retirements.            |

Policy rule review dispositions:

| Disposition         | Count | Meaning                                                           |
| ------------------- | ----: | ----------------------------------------------------------------- |
| `active-custom`     |    21 | Implemented by active `antidrift/*` rules.                        |
| `ecosystem-covered` |    10 | Covered by maintained ESLint ecosystem rules.                     |
| `generated-config`  |     2 | Covered by registry-generated core ESLint config.                 |
| `hook-covered`      |     4 | Covered by generated Claude/Codex hooks.                          |
| `policy-script`     |     3 | Covered by antidrift policy scripts or report generation.         |
| `delegated`         |     2 | Delegated to SonarQube or equivalent external gates.              |
| `merged`            |     1 | Historical policy wording merged into another reviewed rule.      |
| `research`          |    10 | Potential rule, not implemented without real evidence.            |
| `spec-only`         |    10 | Documented policy, intentionally not enforced in the current cut. |

Stable custom rules today:

- `antidrift/no-raw-fetch-in-component`
- `antidrift/no-redundant-zod-parse`
- `antidrift/no-trivial-selector-wrapper`
- `antidrift/no-unsafe-deserialize`
- `antidrift/require-effect-deps`

Default-off custom rules today:

- `antidrift/no-cast-to-branded`
- `antidrift/no-obvious-comment`
- `antidrift/no-role-literal-in-type`
- `antidrift/no-status-triplet-state`

## Stack Rank

This rank is ordered by project value, determinism, and likelihood that the next slice will produce a real decision. A high rank does not always mean "write code next"; several entries need evidence before implementation.

| Rank | Gap                                                                             | Best next slice                                                                                                                              | Why this rank                                                                                                                              |
| ---: | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
|    1 | `antidrift/no-sql-string-concat` stable blockers                                | Classify the broad SQL inventory and resolve or explicitly document non-type-aware imported-escaper degradation.                                | Security value is high and the rule now has production drift, clean controls, lower-edge pressure, imported escaper proof, and a grounded advisory review naming the remaining blockers. |
|    2 | `antidrift/no-defensive-shape-probing` second drift repo                        | Search only when new repos are available for another broad `any`/`unknown` mini-parser that probes many possible fields instead of validating through an owner. Prefer `unknown`-typed drift or benchmark evidence not already explained by upstream unsafe rules. | This maps directly to the "getBoolean checks every property" concern, but current `any` drift partially overlaps `@typescript-eslint/no-unsafe-member-access`; the 2026-06-09 syntax sweep added clean controls and found no second drift. |
|    3 | `antidrift/no-underchecked-type-predicate` second drift and delegation pressure | Find another evaluable broad-input object predicate that claims a contract without checking asserted fields, plus a delegated-validator clean control. Recheck Opencode UI when its tsconfig dependencies resolve. | This is the stronger, type-aware answer to unsafe predicate authority. Sudocode added clean pressure, but stable promotion still needs a second evaluable drift. |
|    4 | `antidrift/no-canonical-model-fork` second configured repo                      | Run a configured domain-owner inventory in another repo with real first-party model owners.                                                  | One-owner-per-concept is the project thesis; the rule is registry-gated enough to avoid broad heuristic matching.                          |
|    5 | `antidrift/no-structural-type-fork` independent replication                     | Seek independent installed-package or generated-source fork replication and more boundary DTO clean pressure.                                | Core rule, already mature locally, but stable promotion still needs independent replication outside current anchors.                       |
|    6 | `antidrift/no-coupled-state-setters` inventory classification                   | Classify broad Chaski findings into true state-machine drift, acceptable handlers, and false positives.                                      | React state shape is original scope, but broad findings can become noisy if not classified before tightening.                              |
|    7 | `antidrift/no-nullable-positional-tuple` second tuple program                   | Find another real nullable/optional multi-slot tuple and clean tuple controls.                                                               | Deterministic AST and low false-positive risk, but narrower impact than parse/cast/model drift.                                            |
|    8 | `antidrift/no-inline-structural-type-at-use-site` replication and exclusions    | Seek independent boundary-function drift plus UI props/callback clean pressure.                                                              | Valuable type-contract rule, but likely expressible by config in some shapes and needs more real pressure.                                 |
|    9 | `antidrift/no-cast-to-branded` adoption or retirement                           | Decide whether real consumers will adopt `@joedeleeuw/antidrift/brand`; otherwise retire to ecosystem-covered.                               | Brands are core to "cannot cast your way to authority," but no real forged-brand drift exists yet. This is a decision gate, not code work. |
|   10 | `antidrift/require-authz-check` scope decision                                  | Decide whether middleware dominance or tRPC procedure authorization is in scope before writing code.                                         | Security value is high, but wrong widening could create a large, framework-specific rule. Scope first.                                     |
|   11 | `antidrift/no-status-triplet-state` low-noise inventory or retirement           | Run another frontend inventory with configured name groups, then keep off or retire if signal stays too heuristic.                           | The smell is real, but the signal is name-group-based by nature. Treat as evidence-gathering, not implementation.                          |
|   12 | `antidrift/no-raw-tailwind-color` inventory classification                      | Classify broad design-system findings before stable claims.                                                                                  | Useful policy, but less central to the original type/parse/authority problem and likely inventory-heavy.                                   |
|   13 | `antidrift/no-hover-translate-card` second UI inventory and CSS boundary        | Run another UI repo inventory; decide whether CSS `@apply` is in or out.                                                                     | Small, deterministic, and bounded, but lower strategic leverage.                                                                           |
|   14 | `antidrift/no-status-literal-in-type` independent status-fork replication       | Find another configured domain-status redeclaration outside the owner.                                                                       | Useful registry-backed drift check, but status evidence is less urgent than model/type forks.                                              |
|   15 | `antidrift/no-role-literal-in-type` real role redeclaration or retire           | Find a real multi-literal role-union redeclaration, or keep default-off/retire.                                                              | Role values are generic and false-positive-prone without strong type context.                                                              |
|   16 | `antidrift/no-async-array-method` second drift or exception                     | Find another independent async array-method drift instance or explicitly accept one-repo evidence.                                           | Deterministic and useful, but lower leverage and already partly adjacent to ecosystem rules.                                               |
|   17 | `antidrift/no-unsafe-cast-chain` independent replication                        | Seek another double-cast tunnel, otherwise keep behind `no-appeasement-cast`.                                                                | Narrow tunnel is mostly subsumed by the broader appeasement-cast rule.                                                                     |
|   18 | `antidrift/no-obvious-comment` inventory or retire                              | Run another inventory only if comment-quality enforcement becomes important.                                                                 | Token-overlap heuristic; not central enough to spend custom-rule time without strong evidence.                                             |

## Broad Policy Gap Rank

These are not part of the current implementation scope unless a new issue widens scope with real-program evidence.

| Rank | Policy gap                                                           | Why                                                                                                                                            |
| ---: | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `errors/no-fallback-to-empty`                                        | Returning `[]` or `{}` from a catch remains a real agent failure mode with a clearer construction pattern than generic silent-catch detection. |
|    2 | `boundary/no-env-access-in-client`                                   | Side-effect boundary rule with likely deterministic file/context checks; evaluate maintained `eslint-plugin-n` / config coverage first.        |
|    3 | `perf/require-timeout-for-network-call`                              | Strong gateway construction pattern if scoped to approved network call sites.                                                                  |
|    4 | `perf/no-unbounded-promise-all`                                      | Useful when tied to obvious unbounded collections, but needs careful false-positive control.                                                   |
|    5 | `auth/no-boundaryless-route` and `auth/no-client-only-authorization` | Valuable but framework-specific; should wait until authz scope is settled.                                                                     |
|    6 | MCP allowlist/version controls                                       | Supply-chain useful, but belongs in policy scripts/config checks, not source-code lint.                                                        |
|    7 | Secret scanning                                                      | High value, but should be delegated to a maintained scanner/Sonar/CI path rather than custom AST code.                                         |
|    8 | Feature scatter and high-fan-in growth                               | Architecture-health signals, but not likely to be deterministic enough for a blocking local ESLint rule.                                       |
|    9 | Observability async-boundary/fire-and-forget tracking                | Potentially valuable, but needs a concrete local logging/tracing convention first.                                                             |
|   10 | Vague agent-rule detection and generic AI copy                       | Heuristic by nature; keep out of blocking scope unless a deterministic corpus-backed signal emerges.                                           |

## Active Rule Gaps

These are implemented-rule gaps. They are not all implementation tasks; many are evidence gates.

| Rule                                              | Current state             | Gap to surface                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-appeasement-cast`                   | Ready, not stable         | Copy-backed repair patterns are proven, but stable promotion should wait for broad inventory after real consumer cleanup.                                                                                  |
| `antidrift/no-async-array-method`                 | Ready, not stable         | Needs a second independent real drift instance, or an explicit one-repo evidence exception.                                                                                                                |
| `antidrift/no-cast-to-branded`                    | Under-proven, default-off | No real non-test forged branded cast is known. Zod brand target detection, `TSTypeAssertion`, and double-cast ownership are not production-proven. Retire if evidence does not appear.                     |
| `antidrift/no-coupled-state-setters`              | Ready, not stable         | Broad Chaski inventory has many findings that need classification before broad claims.                                                                                                                     |
| `antidrift/no-defensive-shape-probing`            | Ready, not stable         | Has clean breadth but only one drift repository. Current `any` drift is same-file partial overlap with upstream unsafe member-access reports; a 2026-06-09 syntax sweep across the active real-repo set found no second drift, so promotion waits for a new repo or newly discovered broad-value mini-parser. |
| `antidrift/no-hover-translate-card`               | Ready, not stable         | Needs another UI repo inventory. CSS `@apply hover:-translate-*` remains outside the JSX class extractor.                                                                                                  |
| `antidrift/no-inline-structural-type-at-use-site` | Ready, not stable         | Needs independent repo replication and more pressure on local UI-prop/callback-payload exclusions.                                                                                                         |
| `antidrift/no-nullable-positional-tuple`          | Ready, not stable         | Needs another real nullable positional tuple and clean tuple-control replication. Alias/generic-chain nullability depends on parser services; imported owner range aliases are intentionally out of scope. |
| `antidrift/no-obvious-comment`                    | Ready, default-off        | Token-overlap heuristic. Needs another repo inventory with low false positives before it can block.                                                                                                        |
| `antidrift/no-raw-tailwind-color`                 | Ready, not stable         | Broad Chaski inventory has many findings that need classification before broad claims.                                                                                                                     |
| `antidrift/no-role-literal-in-type`               | Under-proven, default-off | Needs a real non-disabled multi-literal role-union/type-literal redeclaration outside the owner. Generic role words such as owner/admin/member/viewer are too weak alone.                                  |
| `antidrift/no-sql-string-concat`                  | Ready, not stable         | Has second-repo sanitized identifier replication through Opencode plus lower-edge and imported escaper proof through PowerSync. Stable is blocked by the unclassified 168-finding SQL scan and type-aware-only imported escaper proof. |
| `antidrift/no-status-literal-in-type`             | Ready, not stable         | Needs independent status-fork replication with configured domain facts.                                                                                                                                    |
| `antidrift/no-status-triplet-state`               | Ready, default-off        | Configurable name-group heuristic. Needs multiple low-noise frontend inventories before blocking.                                                                                                          |
| `antidrift/no-structural-type-fork`               | Ready, not stable         | Installed-package and generated-source variants need independent replication plus more boundary DTO/view-model clean pressure.                                                                             |
| `antidrift/no-canonical-model-fork`               | Ready, not stable         | Needs another configured repository inventory. Boundary DTOs and view models can legitimately overlap, so promotion needs broader clean pressure.                                                          |
| `antidrift/no-underchecked-type-predicate`        | Ready, not stable         | Needs another broad-input underchecked predicate drift case. Sudocode now supplies clean pressure for field-complete and union-discriminant predicates; Opencode UI has a plausible drift candidate blocked by missing tsconfig deps. |
| `antidrift/no-unsafe-cast-chain`                  | Ready, not stable         | Needs independent cast-tunnel replication. Lower priority because `no-appeasement-cast` covers the higher-value type-escape surface.                                                                       |
| `antidrift/require-authz-check`                   | Ready, not stable         | Current scope is handler-local Express-style param reads. Express mount middleware dominance, tRPC procedures, boundaryless routes, and client-only auth are not covered.                                  |

## Policy Coverage Gaps

These come from `docs/policy-coverage.md`. Do not implement them automatically; the scoped roadmap still controls work.

| Cluster                       | Current coverage | Gap                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-state-shape`           | Partial          | `react/no-use-state-waterfall` and `react/no-effect-fetch-waterfall` are not separate custom rules. `no-status-triplet-state` is default-off because it is heuristic.                                                                     |
| `type-contract-shape`         | Partial          | `no-explicit-return-type-private-helper` is retired. `no-defensive-shape-probing` is limited to broad-value extractor evidence. `no-cast-to-branded` waits for real brand adoption. Overload/recursive helper allowlists are not modeled. |
| `abstraction-and-file-shape`  | Spec only        | One-use helper, max function/component lines, and high-touch file growth are not enforced locally. `no-obvious-comment` is implemented but default-off.                                                                                   |
| `semantic-architecture-drift` | Partial          | Feature scatter and high-fan-in growth are not enforced locally. Import cycles are delegated to `import-x/no-cycle`.                                                                                                                      |
| `side-effects-and-boundaries` | Partial          | Client env access is not enforced.                                                                                                                                                                                                        |
| `domain-model-drift`          | Partial          | Role literal enforcement is default-off. Canonical model fork detection is registry-gated and intentionally limited to configured exported object models.                                                                                 |
| `authorization-control-drift` | Partial          | Boundaryless routes, client-only authorization, middleware dominance, and tRPC authorization are not enforced.                                                                                                                            |
| `error-handling`              | Partial          | ESLint `preserve-caught-error` now covers lost `cause`; fallback-to-empty remains unimplemented.                                                                                                                                          |
| `design-system`               | Partial          | Generic AI copy is not enforced.                                                                                                                                                                                                          |
| `observability-drift`         | Spec only        | Async-boundary context and fire-and-forget tracking are not implemented.                                                                                                                                                                  |
| `performance-resource-drift`  | Partial          | IO-specific await-in-loop narrowing, unbounded `Promise.all`, and network timeout enforcement are not implemented.                                                                                                                        |
| `injection-and-secret-drift`  | Partial          | Secret scanning is specified but not wired. SQL coverage stays layered between SonarJS and the custom HogQL/template guard.                                                                                                               |
| `quality-gate-drift`          | Partial          | CI/Sonar weakening is not fully modeled beyond protected file checks.                                                                                                                                                                     |
| `mcp-tooling-drift`           | Spec only        | MCP server allowlist and version controls are not implemented.                                                                                                                                                                            |
| `sonar-governance`            | Delegated        | Quality gate enforcement depends on the Sonar server configuration.                                                                                                                                                                       |
| `agent-instructions`          | Partial          | Vague-rule detection is not implemented.                                                                                                                                                                                                  |

No current gap is recorded for retired Oxlint baseline parity, generated-source scope as currently declared, agent hook path, or the declared Vitest test-integrity scope.

## Real-Corpus Blockers

| Blocker                                                                                                               | Affected rule                       | Current handling                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL stable-promotion blockers remain after imported escaper proof.                                                   | `antidrift/no-sql-string-concat`    | Keep ready until broad SQL findings are classified and non-type-aware imported-escaper behavior is resolved or explicitly accepted.              |
| Cloudflare example package tsconfigs extend `agents/tsconfig`, which is not install-resolvable in the external clone. | `antidrift/no-appeasement-cast`     | A real WebSocket `JSON.parse(...) as OutgoingMessage` contract-assertion case is recorded as `known-gap`; it is not a deserialize blocker.           |
| Brand kit is not adopted by enough real consumer code.                                                                | `antidrift/no-cast-to-branded`      | Keep default-off; current Codebase Atlas Zod-brand clean control is weak until target detection is broadened or real antidrift brand usage appears. |
| Role literals are too generic without a strong redeclaration context.                                                 | `antidrift/no-role-literal-in-type` | Keep default-off and require a multi-literal type-context drift example before enablement.                                                          |

## Research Or Retired Boundaries

These are not active implementation gaps unless a new issue widens scope with real-program evidence.

| Item                                               | State             | Reason                                                                                                                               |
| -------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `antidrift/no-cycle`                               | Retired           | Replaced by `import-x/no-cycle`.                                                                                                     |
| `antidrift/no-inline-disable-without-ticket`       | Retired           | Replaced by directive-description and TypeScript-comment rules.                                                                      |
| `antidrift/no-sdk-direct-use`                      | Retired           | Replaced by generated `no-restricted-imports` from gateway registry facts.                                                           |
| `antidrift/no-explicit-return-type-private-helper` | Retired           | Real code showed private helper return types are often legitimate contracts.                                                         |
| `antidrift/no-silent-catch`                        | Retired           | Maintained `no-empty`, `no-console`, and SonarJS catch rules cover enough of the low-value surface.                                  |
| `antidrift/no-thin-typed-factory-wrapper`          | Retired           | No real non-test exact-forward internal drift was found; broader typed-constructor wrappers and exported facades are clean controls. |
| `antidrift/no-same-schema-recertification`         | Research          | Do not implement until Codebase Atlas roundtrip anchors are classified and a second repo proves remediated-value drift.              |
| Discriminated-union coverage                       | Ecosystem-covered | Prefer `@typescript-eslint/switch-exhaustiveness-check` and adjacent type-aware rules before custom work.                            |

## Next Evidence Slices

1. `antidrift/no-sql-string-concat`: classify the broad SQL inventory and resolve or document the parser-services degradation for imported escaper proof.
2. `antidrift/no-defensive-shape-probing`: find a second broad-value mini-parser drift repo, preferably `unknown`-typed or otherwise not explained away by upstream unsafe member-access rules.
3. Default-off rules: decide whether `no-cast-to-branded`, `no-role-literal-in-type`, `no-obvious-comment`, and `no-status-triplet-state` can earn evidence or should stay off/retire.
4. Inventory-heavy rules: classify broad findings for `no-coupled-state-setters`, `no-raw-tailwind-color`, and `no-hover-translate-card`.
5. Authz scope: decide whether middleware dominance or tRPC procedure authorization is truly in scope before writing code.
