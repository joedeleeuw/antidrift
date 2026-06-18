# Rule Roadmap

Last updated: 2026-06-14.

This is the decision layer over `policy/registries/rules.yaml`. The registry owns per-rule status, evidence, accepted authority facts, and examples; `docs/rule-status-registry.md` is its readable index. Treat the registry as a project authority index, not a manually curated dependency allowlist: broad scans and repo analytics can propose owners, but blocking rules should rely on accepted or generated ownership facts. This document owns the product answer: which rules antidrift keeps as custom code, which it delegates, which it stops carrying, and what each kept rule must still prove. When this document and the registry disagree, fix the registry first and realign this file.

The north star is `docs/semantic-drift-goal.md`: prove semantic associations from code, type, registry,
graph, or corpus evidence first; keep agent-ops as the minimized fallback for session facts that code
semantics cannot recover; and treat fixtures as regression aids, never promotion evidence.
`docs/semantic-validation-matrix.md` is the operational checklist for which rules move to semantic
adapters, which stay plain source rules, and what validation evidence each carrier needs.

## Problem Kind Comes First

Earlier passes designed rules from syntax without establishing value, so they could not tell whether a detected pattern was a problem in itself, a symptom of a deeper failure, or something a broader upstream rule already owned. Every classification below starts from that question:

- **Problem in itself.** The flagged construction is the policy violation (`useEffect` with no dependency array; `forEach(async ...)`). Deterministic AST or TypeChecker signals can block it directly.
- **Symptom.** The flagged pattern only correlates with the real failure (`data/loading/error` names are a symptom; derivable async lifecycle state modeled as independent mutable cells is the failure). A symptom detector stays inventory/off until it proves the deeper failure.
- **Owned by a broader upstream rule.** A maintained rule covers the family; custom code survives only when the upstream rule is measurably too broad or too narrow to block (`no-unsafe-type-assertion` reports clean SDK conversions; `no-misused-promises` reports real Express handlers).
- **Owned by another layer.** Generated config, the theme/design system, hooks, policy scripts, or an external gate is the better control. Lint is at most a backstop.
- **Authority claim.** Ownership questions (type forks, domain vocabulary, authz policy) cannot be proven by AST shape; they require TypeChecker or registry facts, and the rule is inert without them by design.

The custom surface clusters around three root agent failure modes, and new candidates should trace to one of them:

1. **Net-new bias.** It is easier for an agent to mint a new entry point, type, model, or helper than to find the existing owner and build on top of it. This is the one-owner family — structural, canonical, and status forks, inline boundary contracts, generated-import routing — plus the research tail (feature scatter, one-use helpers).
2. **Unearned type authority.** Code claims a contract it did not earn through parsing, guarding, or importing the owner: appeasement casts, underchecked predicates, weak shape probing, unsafe deserialization.
3. **Hand-rolled lifecycle.** Derivable lifecycle facts modeled as independent mutable state: status triplets, coupled setters, raw fetch in components, missing effect deps.

A custom rule is carried only with all six fields filled: a value statement (the real failure it prevents), a preferred construction pattern, an ecosystem comparison, a declared proof signal, real-code evidence status, and a named false-positive concern. Candidate discovery from work history follows `docs/rule-mining-protocol.md`.

## Authority Index, Not Dependency List

Ownership rules need repo facts that source syntax alone cannot prove. The registry exists for those facts; it should not become a hand-written list of every dependency a consumer might install.

The intended flow for package and generated ownership is:

1. **Discover** possible owners automatically. TypeChecker scans can find local shapes that match package exports, generated outputs, or domain owner exports.
2. **Score** the match with repo evidence. Confidence rises when the repo already imports the owner type, derives from it with `Pick`/`Omit`, receives it from an SDK/generated API, or routes access through a generated wrapper.
3. **Record** accepted ownership in the authority index. Generated sources, domain owners, gateways, authz APIs, and approved package-type owners become explicit project facts.
4. **Enforce** only accepted facts. Unapproved all-`node_modules` matches stay inventory/discovery because structural similarity does not prove the package export is this repo's intended contract.

This keeps examples like `firebase/auth#User` useful without hardcoding Firebase into Antidrift. The detector can say a local type matches `firebase/auth#User`; the authority index is what says this repo should import or derive from that owner instead of redeclaring it.

## Proof Surface Buckets

Every candidate must land in one proof bucket before implementation, or stay in research with its likely target bucket named. "Could be found with AST" is not enough; the bucket is defined by the smallest proof object that can justify blocking or advising. Syntax finds suspects; semantic proof earns enforcement. Buckets are proof surfaces, not ownership status: a row can be AST-proven and still be delegated to an ecosystem rule if the ecosystem already owns it.

| Bucket                                         | Proof object                                                                                                                                                                   | Carrier                                                                                                                                                                         | Current rows                                                                                                                                                                                                                                                                                                           | Promotion rule                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Local AST/source-shape proof**            | One file's syntax, import bindings, string literals, or lexical scope proves the construction                                                                                  | ESLint custom rule or maintained ESLint rule                                                                                                                                    | `antidrift/no-trivial-selector-wrapper`, `antidrift/require-effect-deps`, never-await branch of `antidrift/no-async-array-method`, `antidrift/no-inline-structural-type-at-use-site`, `antidrift/no-nullable-positional-tuple`, `antidrift/no-raw-fetch-in-component`, JSX class-string design rules                   | Can block when the construction is the violation. If source shape only names a suspect, demote to inventory or move to B/C/F.                                                                             |
| **B. Semantic source/type/provenance proof**   | AST plus local dataflow, setter transition evidence, TypeChecker facts, schema provenance, SQL/context control flow, or validated broad-input flow proves the contract failure | Type-aware or semantic ESLint custom rule                                                                                                                                       | `antidrift/no-appeasement-cast`, `antidrift/no-unsafe-deserialize`, `antidrift/no-sql-string-concat`, `antidrift/no-underchecked-type-predicate`, `antidrift/no-redundant-zod-parse`, blocking branches of `antidrift/no-handrolled-resource-lifecycle-cells`, map/flatMap branch of `antidrift/no-async-array-method` | Can block only after the semantic proof and fallback behavior are characterized against drift and clean controls.                                                                                         |
| **C. Authority-index ownership proof**         | Source shape plus accepted package, domain, generated, authz, or owner facts proves the code forked or bypassed an owner                                                       | Registry-backed ESLint rule or generated config                                                                                                                                 | `antidrift/no-structural-type-fork`, `antidrift/no-canonical-model-fork`, `antidrift/no-status-literal-in-type`, `antidrift/require-authz-check`, generated source-owner routing                                                                                                                                       | Registry absence means no blocking proof. These rules must fail closed to "not configured" or advisory, not infer owners from names alone.                                                                |
| **D. Graph/config source proof**               | Import graph, file graph, configured path zones, package graph, or generated import restrictions prove the violation                                                           | Import/boundaries plugins, generated `no-restricted-imports`, package graph checks                                                                                              | `arch/no-cross-layer-import`, `arch/no-deep-import`, `arch/no-new-dependency-cycle`, `boundary/no-sdk-direct-use-outside-gateway`, `gen/require-import-from-generated`, mock-import candidates, barrel-file candidates                                                                                                 | Prefer maintained graph/config tools first; custom graph logic needs a measured gap and explicit project facts.                                                                                           |
| **E. Ecosystem/toolchain-owned source policy** | A maintained tool already owns the source, test, React, security, style, or quality law                                                                                        | Existing ESLint plugin, TypeScript rule, Sonar, stylelint/native lint, secret scanner                                                                                           | `react/no-derived-state-effect`, Vitest integrity rules, disable-description policy, `errors/preserve-caught-error`, `perf/no-await-in-loop-with-io`, `sec/no-hardcoded-secret`, broad raw-color checks when a platform scanner owns them                                                                              | Custom code is a last resort after a measured false-negative gap against real code; otherwise the row stays ecosystem-covered or retired.                                                                 |
| **F. Change/repo/session/runtime proof**       | Diff shape, task scope, command history, artifact freshness, runtime/device evidence, or tool config proves the failure                                                        | Replayable policy scripts, diff-relative or repo-graph spines, and thin Codex/Claude/OpenCode/PR/transcript adapters only where the proof needs session or tool lifecycle facts | diff-scope creep, stale or skipped verification, existing-owner-before-new-file, high-touch file growth, feature scatter, runtime proof missing, MCP/tooling config drift, vague agent rules                                                                                                                           | Not an ESLint rule. AST or structural search can be a helper, but blocking proof comes from git/session/runtime/config facts. Diff/graph failures need diff/graph proof; hooks only surface or gate them. |
| **G. Unassigned research or drop**             | The real failure, owner, proof object, or ecosystem gap is not established                                                                                                     | Research inventory, advisory docs, or locked retirement                                                                                                                         | `antidrift/no-same-schema-recertification`, `react/no-use-state-waterfall`, `react/no-effect-fetch-waterfall`, fallback-to-empty, env-in-client, unbounded Promise fan-out, fire-and-forget, one-use-helper, tRPC output schemas, broad domain-literal/schema-fork ideas                                               | No blocking behavior. Move to A-F only after the likely bucket, real drift file, clean control, ecosystem comparison, and false-positive concern are recorded.                                            |

The decision flow is:

1. State the failure without naming syntax. If the sentence cannot explain user harm, keep it in G.
2. Ask what proof would convince a skeptical reviewer. If the proof is just local source shape and the construction is itself the violation, choose A. If syntax only inventories suspects, require B/C/F proof before blocking. If it needs types, provenance, setter transitions, or local control flow, choose B. If it needs declared owners, choose C. If it needs import/file/package graph facts, choose D. If a maintained tool owns the exact construction, choose E. If the proof says "changed," "before/after," "task," "ran," "artifact," "screenshot," "permission," or "config precedence," choose F.
3. Pick the cheapest carrier for that bucket. Do not escalate repo/session proof into a custom ESLint rule; do not build an agent-ops script for a construction already proven by a maintained lint rule; do not use hooks as the proof carrier for a change/graph property that needs replayable diff or graph evidence.
4. Promote only after the carrier reports real drift and clean controls in the relevant environment. "Low noise" means named clean controls plus no known false positives under the configured scope, not a vibe.

## Classification Summary

| Classification                           | Rules                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable custom (6)                        | `no-raw-fetch-in-component`, `no-redundant-zod-parse`, `no-sql-string-concat`, `no-trivial-selector-wrapper`, `no-unsafe-deserialize`, `require-effect-deps`                                                                                                                                                                    |
| Custom, needs real-corpus promotion (11) | `no-appeasement-cast`, `no-structural-type-fork`, `no-canonical-model-fork`, `no-handrolled-resource-lifecycle-cells`, `no-async-array-method`, `no-nullable-positional-tuple`, `no-inline-structural-type-at-use-site`, `no-status-literal-in-type`, `require-authz-check`, `no-raw-tailwind-color`, `no-hover-translate-card` |
| Default-off / pending retirement (2)     | `no-defensive-shape-probing` (sunset condition below), `no-underchecked-type-predicate` (required-field drift search below)                                                                                                                                                                                                     |
| Ecosystem-covered                        | See delegated surface table                                                                                                                                                                                                                                                                                                     |
| Generated-config-covered                 | `boundary/no-sdk-direct-use-outside-gateway`, `gen/require-import-from-generated`                                                                                                                                                                                                                                               |
| Hook/policy-script-covered               | `agent/*` (4 hooks), `policy/no-check-weakening-without-policy-task`, `sonar/import-custom-eslint-issues`, `rules/one-source-generates-agent-files`                                                                                                                                                                             |
| Retire                                   | 11 locked retired rules; plus `no-defensive-shape-probing` at sunset if no distinct drift appears                                                                                                                                                                                                                               |
| Research only                            | `no-same-schema-recertification` plus the policy research/spec-only rows                                                                                                                                                                                                                                                        |

## Change, Repo, And Agent-Ops Roadmap

These are not ESLint rules. They are the candidates whose proof surface includes task intent, diff shape, command history, verification evidence, runtime state, or tool configuration. `docs/rule-mining-protocol.md` classifies those truth artifacts as `diff+task+graph`, `transcript+commands+verification`, or `runtime/device`, which bars plain lint-rule form.

The cheap enforcement stack is:

- **Shared policy scripts first, tool adapters second.** Codex and Claude Code can both run lifecycle hooks, but their precedence and execution semantics differ, and OpenCode uses project rules, config, permissions, and plugins instead of the same hook file shape. The product should be deterministic scripts with thin adapters for Codex hooks, Claude hooks, OpenCode plugins/config, PR bots, and transcript replay.
- **Diff and graph proof are their own spines.** Diff-scope creep, net-new owner bias, feature scatter, and high-touch growth need merge-base, changed-file, AST-diff, owner-index, or module-graph evidence. Agent hooks may run the script or block on its result, but the proof must be replayable without the original chat transcript.
- **Instruction precedence is part of enforcement.** `AGENTS.md` is the portable project instruction target: OpenCode reads project `AGENTS.md` before project `CLAUDE.md`, then global OpenCode rules, then Claude fallback rules. Claude still needs `CLAUDE.md` for native project context, and Codex consumes `AGENTS.md` plus `.codex` hook/config layers.
- **Policy scripts for repo facts.** Diff size, new files, protected config edits, generated artifact drift, and verification freshness are repository-state questions. Prefer small deterministic scripts over LLM judgment.
- **PR bots for pressure before blocking.** Danger and reviewdog are good first carriers for advisory output because they automate rote review comments and can filter findings to the patch. Advisory comments must not become agent auto-remediation instructions unless a separate blocking gate says so.
- **Policy-as-code for structured config.** Conftest/OPA-style checks fit MCP, permission, CI, hook, and policy registry files better than AST rules.
- **Structural search as a subroutine, not a bucket.** If a candidate can be proven from source syntax alone, it graduates back to the lint/equivalence roadmap. In repo/session policy scripts, ast-grep and Semgrep are only cheap helpers for diff-scoped source probes or ownership discovery.

| Candidate                                  | Truth artifact                           | First product                                                                                                                                               | Cheap signal                                                                                                                                                       | Promotion path                                                                                                                                                            | Do not do                                                                              |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Diff-scope creep                           | `diff+task+graph`                        | `diff-budget` policy script with diff-relative proof, surfaced through Codex/Claude lifecycle hooks, OpenCode plugin output, and PR reviewdog/Danger output | `git diff --numstat`, touched top-level packages, new-file count, task-scope labels; exclude lockfiles, generated/vendor paths, snapshots, and declared migrations | Start advisory-only; build accepted-session baselines by task kind; block only narrow classes such as generated-file edits or protected areas without matching task scope | Do not turn line-count alone into a lint rule, global hard cap, or hook-only heuristic |
| Skip verification before done              | `transcript+commands+verification`       | `verify-before-stop` shared policy script with Codex/Claude Stop adapters, OpenCode plugin adapter, and transcript-replay fallback                          | source/executable files changed plus no fresh verifier artifact or command-fingerprint marker newer than the last relevant edit                                    | Already partly covered by `agent/require-checks-before-stop`; add timestamp/fingerprint evidence so stale checks cannot satisfy the gate                                  | Do not trust assistant text that claims tests passed                                   |
| Net-new bias / existing owner missed       | `diff+task+graph`                        | `existing-owner-before-new-file` inventory script backed by owner-index or repo-graph evidence                                                              | new exported type/helper/component plus same-name, same-path-family, registry-declared, or generated-owner candidates from `rg`, package graph, or registry facts  | Advisory PR comments first; promote only for high-confidence cases like new gateway/client/schema file when registry owner exists                                         | Do not ban new files or one-use helpers globally                                       |
| High-touch file growth and feature scatter | `diff+task+graph` plus git history       | PR policy report                                                                                                                                            | file churn over recent commits, cross-feature touched paths, duplicated feature directories, changed-lines concentration                                           | Use as reviewer triage and Sonar complement; block only protected ownership violations with registry facts                                                                | Do not use raw max-lines as the product                                                |
| Runtime/device proof missing               | `runtime/device`                         | route/device smoke manifest checked by shared verification policy adapters                                                                                  | UI/native/runtime files changed and no matching screenshot, Playwright trace, simulator log, or package smoke artifact produced after the change                   | Keep per-project manifests; require artifact freshness for UI/native surfaces where the user will inspect the result                                                      | Do not ask humans to review unverified UI/runtime work                                 |
| MCP/tooling config drift                   | structured config plus tool-call context | generated config/policy script, optionally Conftest/OPA if the schema grows                                                                                 | unpinned MCP server, new permission/tool allowlist, OpenCode config/plugin precedence drift, local-only config drift, broad shell allow entries                    | Start with JSON/YAML schema validation; gate protected config edits in `policy:check:changed`; escalate to hook/plugin-level approval for side-effecting tools            | Do not encode this as TypeScript source lint                                           |
| Vague agent rules                          | `none` until phrase taxonomy exists      | advisory docs check                                                                                                                                         | markdownlint/Vale-style prose checks for rules with no action, owner, trigger, or verification command                                                             | Keep as review guidance until examples and false-positive review exist                                                                                                    | Do not make prose heuristics blocking                                                  |

The first implementation tranche should be `diff-budget`, `verify-before-stop` freshness, and `existing-owner-before-new-file`, in that order. They are cheap because they reuse existing git, registry, hook, and PR-comment plumbing; they also target the highest-recurrence mined complaints without pretending task intent is source syntax.

Research anchors:

- Codex hook discovery, trust, and lifecycle events: <https://developers.openai.com/codex/hooks>
- Claude Code hook events and decision control: <https://code.claude.com/docs/en/hooks>
- OpenCode rules precedence: <https://opencode.ai/docs/rules/>
- OpenCode config precedence: <https://opencode.ai/docs/config/>
- OpenCode plugin load order and hook surface: <https://opencode.ai/docs/plugins/>
- OpenAI guardrails and human review: <https://developers.openai.com/api/docs/guides/agents/guardrails-approvals>
- OpenAI Agents SDK guardrail boundaries: <https://openai.github.io/openai-agents-python/guardrails/>
- Danger JS for rote PR review chores: <https://danger.systems/js/>
- reviewdog for diff-scoped review comments: <https://github.com/reviewdog/reviewdog>
- Conftest/OPA for structured configuration policy: <https://www.conftest.dev/>
- ast-grep structural search/linting: <https://ast-grep.github.io/>
- Semgrep custom rule syntax: <https://docs.semgrep.dev/writing-rules/overview>

## Stable Custom

These six passed the stable bar: independent multi-repo drift not created for the rule, clean controls, zero known false positives, zero known false negatives in the inspected corpus, no unresolved production concerns, and advisory review.

### `antidrift/no-raw-fetch-in-component`

- Value: components that call `fetch` own transport policy; auth headers, retries, caching, and error handling fragment per component and data loading waterfalls behind render.
- Problem kind: problem in itself at a boundary — the fetch call inside a component module is the violation.
- Pattern: route data through the data layer (query hooks, gateway/client module); components consume hooks.
- Ecosystem: `no-restricted-syntax` could ban `fetch` per glob but cannot express component context; no maintained component-boundary rule exists.
- Signal: import-scope plus AST (`fetch`, `globalThis.fetch`, `window.fetch`, `self.fetch`).
- Evidence: drift in Chaski, Codebase Atlas, and Murderbox; clean controls include API modules and query-hook components.
- False-positive concern: none known; aliased/destructured fetch is an unobserved scope boundary to monitor until real evidence appears. The separate raw-transport future rule now has its first complaint provenance ("why is there axios in the BFF", 2026-06-10 sweep).

### `antidrift/no-redundant-zod-parse`

- Value: re-parsing a value the same schema already produced re-certifies trusted data, hides where the real boundary is, and adds runtime cost.
- Problem kind: problem in itself, proven by provenance — the TypeChecker shows the value is already that schema's output.
- Pattern: parse once at the boundary; pass typed results and let the type system carry the proof.
- Ecosystem: no Zod rule tracks schema provenance (net-antidrift).
- Signal: TypeChecker plus schema provenance.
- Evidence: Chaski router reparse and Murderbox production reparse; clean first-boundary pipelines in three repos.
- False-positive concern: throw-style schema-contract test assertions are excluded; first-boundary pipelines may need more clean exclusions over time.

### `antidrift/no-trivial-selector-wrapper`

- Value: a helper that only returns a member of its own parameter, with an explicit return annotation, adds indirection plus a hand-maintained contract that inference already provides.
- Problem kind: problem in itself, structurally. The old `getXFromY` name gate was the symptom version; names are gameable, the return shape is not.
- Pattern: inline the member access, or keep the named helper and drop the annotation.
- Ecosystem: none (net-antidrift).
- Signal: AST structural return shape.
- Evidence: drift in Chaski, Codebase Atlas (`fullExcerpt`), and Murderbox (annotated key-extractor callback); transforming helpers stay clean.
- False-positive concern: external APIs that genuinely require an annotated callback signature — handled by a rule-specific disable with a required reason, never by name heuristics.

### `antidrift/no-unsafe-deserialize`

- Value: `JSON.parse` over `any`/`unknown` input lets raw external data enter typed code with no boundary; downstream code consumes unvalidated structure as if typed.
- Problem kind: problem in itself at the parse boundary, proven by the input type — not by `req`/`ctx` name fingerprints (the retired symptom version).
- Pattern: guard to string, parse, validate the output with the owning schema (parse-at-edge).
- Ecosystem: `@typescript-eslint/no-unsafe-argument` catches some flows but is not parse-at-edge guidance (partial overlap).
- Signal: TypeChecker plus local string-boundary control flow.
- Evidence: Sudocode route drift and Opencode bench drift; clean storage/schema-piped parses across three repos.
- False-positive concern: parse-output assertions (`JSON.parse(x) as T`) belong to `no-appeasement-cast`, not here; the Cloudflare checkout stays a non-evaluable known gap.

### `antidrift/require-effect-deps`

- Value: `useEffect(fn)` with no dependency array runs after every render, which is almost never intended; `react-hooks/exhaustive-deps` deliberately stays silent on the missing-array case.
- Problem kind: problem in itself — the missing argument is the violation, and it is exactly the gap upstream chose not to own.
- Pattern: declare the dependency array; intentional every-render effects use the rule-specific disable with a required reason.
- Ecosystem: `exhaustive-deps` validates arrays that exist; `eslint-plugin-use-effect-no-deps` is single-purpose and dormant (partial overlap, no strong replacement).
- Signal: import binding plus AST.
- Evidence: Chaski and Claude Code Source drift; clean controls in four repos.
- False-positive concern: intentional every-render effects — covered by described disables backed by `require-description`.

## Custom, Needs Real-Corpus Promotion

Implemented and enabled; each card names what still blocks stable promotion.

### `antidrift/no-appeasement-cast`

- Value: `broadValue as NamedContract` manufactures type authority exactly where validation was needed; failures surface later as property crashes far from the boundary that should have parsed or guarded.
- Problem kind: problem in itself when the checker proves the source is `any`/`unknown`. The broader assertion family is upstream-owned and is a measured superset.
- Pattern: guard (`isAxiosError`), parse with the owning schema, or import the owner's types — earn the contract.
- Ecosystem: `@typescript-eslint/no-unsafe-type-assertion` reported every antidrift cast-family location across 2,411 real files plus ~1,331 upstream-only locations, including clean typed SDK conversions. Too broad to block; kept as an optional strict benchmark.
- Signal: TypeChecker.
- Evidence: drift in Chaski, Codebase Atlas, and Sudocode; copy-backed repairs prove the replacement patterns; production BFF clean (0 findings/112 files).
- False-positive concern: typed-source conversions stay clean by design; test-file casts report but do not count toward promotion.
- Blocker: rerun broad inventory after real consumer cleanup; no further copy-only remediation.

### `antidrift/no-sql-string-concat`

- Value: SQL assembled by interpolation or concatenation reaches the database without a binding or escaping boundary — injection and quoting bugs. Measured SonarJS coverage misses every real case (0 vs 16 findings on 338 files; 0 vs 31 on the 24-repo fleet).
- Problem kind: two branches with different proof burdens. Value interpolation is a problem in itself once SQL syntax context is proven. Identifier interpolation is an authority claim: clean only with allowlist, typed union, static map, anchored regex exit guard, or escaper proof — and imported-escaper/safe-member proof requires parser services.
- Pattern: bound parameters for values; allowlists, escapers, or `sql.identifier(...)` for identifiers; parameterized tags.
- Ecosystem: `sonarjs/sql-queries` is adjacent but missed every real finding; SQL-template plugins assume chosen tag conventions (partial overlap).
- Signal: SQL-context AST plus scope-binding guard control flow plus TypeChecker escaper/member proof.
- Evidence: production drift in Chaski (HogQL) and PowerSync service; lower-strength test/demo drift in Sudocode and Cloudflare; the 24-repo fleet is classified with 0 known type-aware false positives.
- False-positive concern: without parser services, three known-clean PowerSync escaper controls degrade to conservative reports. `parserServiceDeltas` classifies those as inventory because the type-aware plans prove them clean and there are zero missing non-type-aware findings.
- Status: stable for the observed SQL interpolation and identifier-proof surface. Keep the benchmark and source-fleet inventories as regression gates before widening SQL tag, guard, placeholder arithmetic, or builder-append coverage.

### `antidrift/no-underchecked-type-predicate`

- Value: a predicate that asserts `value is Contract` after probing nothing, or a single token field, launders broad input into trusted types — an appeasement cast wearing a guard's clothes, and the claim persists at every call site.
- Problem kind: the degenerate zero-field authority claim is a problem in itself. "Checked some fields, maybe not enough" is a sufficiency heuristic — symptom territory — and stays non-blocking.
- Pattern: check the asserted fields, discriminate an already-typed union, or delegate to the owning schema/validator.
- Ecosystem: no type-aware rule validates predicate-body sufficiency (net-antidrift).
- Signal: TypeChecker plus AST/control-flow checks.
- Evidence: after required-property narrowing, `pnpm policy:inventory-underchecked-predicate` checks 1,321 type-aware files with 0 parser errors, 63 predicate candidate files, 111 predicate signatures, and 0 findings across Chaski BFF, Chaski monolith UI, Codebase Atlas, Sudocode CLI/frontend/server, and Opencode UI. The former Chaski `RetoolLineItemData` and Opencode `TriggerTitle` findings are optional-heavy clean controls under the current proof floor.
- False-positive concern: the verdict layer is heuristic — validator-looking helper names can produce false negatives; keep the blocking branch at the degenerate claim.
- Blocker: default-off until a real broad-input predicate misses required asserted fields. Optional-field sufficiency remains inventory/research unless a stronger proof exists.

### `antidrift/no-structural-type-fork`

- Value: hand-written copies of types a package or generated source already exports drift silently when the owner changes; consumers keep compiling against stale shapes.
- Problem kind: authority claim. Generated-source, domain, and accepted package-owner modes carry real owner facts; the unconfigured all-`node_modules` sweep is analytics for finding candidate owners, not proof that every matching package export is this repo's intended contract.
- Pattern: import the owner's type; project with `Pick`/`Omit` from the owner.
- Ecosystem: none compares local shapes against package/generated exports (net-antidrift).
- Signal: TypeChecker structural comparison plus authority-index facts.
- Evidence: two generated-source forks in Chaski BFF (123 files); 0 findings across 804 Portal files with installed-only sources; fixture coverage proves accepted package owners from `ownership.yaml` report while unaccepted package matches stay inventory-only.
- False-positive concern: projected boundary DTOs with four or more identical owner fields may be legitimate translation contracts; the installed-package mode is the weak-authority branch.
- Blocker: stable promotion needs independent generated-source replication and real accepted package-owner evidence before any package owner is added to `ownership.yaml`; the unconfigured all-`node_modules` sweep stays inventory/discovery.

### `antidrift/no-canonical-model-fork`

- Value: first-party domain models redeclared outside the owner file fork the domain vocabulary — one concept, two shapes, independent drift.
- Problem kind: authority claim backed by the `canonicalEntities` registry; inert without configuration by design.
- Pattern: import the owner's model; schema-inferred DTO aliases stay clean.
- Ecosystem: no rule can know repo model ownership (net-antidrift).
- Signal: TypeChecker plus domain registry.
- Evidence: three redeclarations in one Chaski report-types file; Sudocode `frontend/src/types/project.ts` redeclares server-owned `ProjectInfo`; owner files and a different weekly-digest model stay clean.
- False-positive concern: boundary DTOs and view models legitimately overlap; the four-property threshold keeps small shapes out.
- Blocker: fresh adversarial review and broader boundary DTO/view-model clean pressure before stable promotion.

### `antidrift/no-handrolled-resource-lifecycle-cells`

- Value: one handler mutating several state cells is an implicit state machine; transitions drift independently and produce impossible intermediate states.
- Problem kind: scope-binding proves co-mutation inventory, not blocking harm. Blocking needs semantic transition evidence, such as a redundant constant lifecycle cell written whenever a sibling receives the resource value.
- Pattern: a reducer, a discriminated-union cell, or a resource hook.
- Ecosystem: none models coupled setter bindings (net-antidrift).
- Signal: source binding plus local transition/control-flow proof.
- Evidence: current fixed-proof `pnpm policy:inventory-react-state` checked 1,533 Chaski frontend files, kept 100 broad co-mutation facts inventory-only, and emitted 2 blocking lifecycle diagnostics in Chaski reporting screens. The older seven-repo broad co-mutation scan is still useful false-positive pressure, but it predates the fixed lifecycle proof and no longer settles enforcement readiness.
- False-positive concern: legitimate multi-cell form and view-state handlers dominate broad co-mutation, so broad co-mutation remains inventory only.
- Blocker: validate the fixed lifecycle proof in a second independent React repo and review the 2 Chaski positives before stable promotion. Broad co-mutation alone must not block.

### `antidrift/no-async-array-method`

- Value: async callbacks in never-await methods (`forEach`, `filter`, `some`) silently discard promises — work runs unawaited and errors vanish; `map`/`flatMap` is only safe when the promise list is collected.
- Problem kind: split. The never-await branch is a problem in itself (the method discards returns by contract). The `map`/`flatMap`-not-collected branch carries a separate local dataflow burden.
- Pattern: `for...of` with `await`, or `Promise.all`/`allSettled` over `map`.
- Ecosystem: `@typescript-eslint/no-misused-promises` with `checksVoidReturn.arguments` catches this but also reports real Express handlers, so the baseline deliberately disables that path (partial overlap, broader upstream).
- Signal: AST.
- Evidence: one real drift across 2,293 files (Sudocode test cleanup `forEach(async ...)`); broad clean controls.
- False-positive concern: low; the open question is promotion policy, not signal quality.
- Blocker: decision 6 below — branch-split promotion.

### `antidrift/no-nullable-positional-tuple`

- Value: tuples with two or more nullable/optional slots encode partial state positionally; readers must memorize slot meaning and which combinations are valid (`[Date | null, Date | null]`).
- Problem kind: problem in itself; nullability is the boundary because it creates ambiguous partial-state combinations — plain positional tuples stay legitimate.
- Pattern: named object fields or an explicit state union.
- Ecosystem: none for the narrowed smell (net-antidrift).
- Signal: deterministic AST; alias/generic-chain nullability needs parser services.
- Evidence: exactly 1 finding across 1,533 Chaski frontend files — precise and low-yield.
- False-positive concern: hook-style tuples with one nullable slot stay clean; imported owner range aliases are out of scope. Low frequency lowers priority, not validity.
- Blocker: a second real nullable tuple plus clean tuple controls.

### `antidrift/no-inline-structural-type-at-use-site`

- Value: anonymous object contracts at exported/boundary surfaces cannot be referenced, reused, or owned; every caller re-derives the shape.
- Problem kind: problem in itself only at boundaries; local props and callbacks are excluded. This is boundary-shape hygiene, deliberately separate from the fork family.
- Pattern: name the contract and export it beside the boundary.
- Ecosystem: `no-restricted-syntax` can ban `TSTypeLiteral` but cannot express boundary narrowing (config-replacement candidate; keep custom while the exceptions matter).
- Signal: AST.
- Evidence: Chaski only — 24 findings across 4 files after narrowing.
- False-positive concern: local UI props and callback payload exclusions need more independent pressure.
- Blocker: independent repo replication.

### `antidrift/no-status-literal-in-type`

- Value: status unions redeclared away from the registry-configured owner fork the domain vocabulary one literal at a time.
- Problem kind: authority claim via the domain registry, context-narrowed to status-shaped type positions.
- Pattern: import the owner's status type.
- Ecosystem: generated `no-restricted-syntax` could match literals but cannot carry owner-file exceptions (config-replacement candidate).
- Signal: registry plus AST context.
- Evidence: Chaski orders-ops redeclaration; the owner file stays clean.
- False-positive concern: generic UI variant unions that resemble domain statuses — already guarded by status-context narrowing after a real Portal false positive.
- Blocker: independent status-fork replication with configured domain facts.

### `antidrift/require-authz-check`

- Value: a handler that reads route params and acts on the resource without any co-located authorization/ownership decision is a missing boundary check.
- Problem kind: absence detection — inherently fragile because middleware, higher-order handlers, and framework wrappers can legitimately own the check. The durable form is a positive construction pattern: handlers registered through a typed policy-bearing wrapper.
- Pattern: handler-local authz call today; typed policy-wrapper registration as the target pattern.
- Ecosystem: no rule knows repo authz policy (net-antidrift); the calls that count are registry facts.
- Signal: AST control flow plus registry.
- Evidence: Sudocode route drift (4 files); Chaski is non-applicable (tRPC boundaries) and stays a clean corpus for this shape.
- False-positive concern: middleware-dominant apps would over-report — the rule stays glob-scoped opt-in and must not widen until decision 7 lands.
- Blocker: decision 7 below; scope frozen meanwhile.

### `antidrift/no-raw-tailwind-color`

- Value: raw palette utilities (`text-red-500`) bypass semantic tokens, so design changes stop propagating and the UI drifts off-theme.
- Problem kind: the class string is the policy surface (no intent inference needed) — but the failure may be owned by another layer: a theme that does not expose raw palette utilities makes the drift unconstructable.
- Pattern: semantic token classes; preferably theme-level removal of the raw palette.
- Ecosystem: Tailwind plugins validate utility correctness, not token governance (config-replacement candidate).
- Signal: class-string extraction.
- Evidence: Chaski drift; 252 findings across 61 files (cleanup-scale inventory).
- False-positive concern: the regex is a sampler unless tied to the project's actual token surface; coverage must be stated honestly.
- Blocker: decision 8 below — control layer — before more promotion effort.

### `antidrift/no-hover-translate-card`

- Value: hover-translate on card-like pointer targets is a banned interaction pattern in the local design language.
- Problem kind: the class string is the policy surface; same control-layer question as raw colors.
- Pattern: hover elevation/color tokens instead of movement.
- Ecosystem: nothing owns this interaction policy; `no-restricted-syntax` would be less readable (config-replacement candidate).
- Signal: class-string extraction (JSX only; CSS `@apply` is a known false-negative boundary).
- Evidence: Sudocode FAB drift; Chaski clean (0 findings).
- False-positive concern: translate outside hover or on non-pointer targets stays clean; lowest strategic leverage in the active set — keep only because it is cheap.
- Blocker: second UI repo inventory; decision 8 below.

## Default-Off Inventory

Severity discipline applies: these must not block while under-proven.

### `antidrift/no-status-triplet-state` — retired

- Intended value: derivable async resource lifecycle state modeled as independent mutable cells — `loading`/`error`/`data` can disagree because every transition is hand-written.
- Problem kind: symptom detector. Name groups detect the vocabulary, not the failure; identically-named cells fed by TanStack Query are clean. The deterministic proof of the real failure — one setter writing a constant whenever a sibling setter receives the resource value — is a coupled-setters branch, not a name rule.
- Evidence: 2 findings/2 files in Chaski; honest but name-based.
- Disposition: retired and locked. The redundant-constant-cell branch now lives inside `no-handrolled-resource-lifecycle-cells`; the intent survives, but the standalone symptom detector does not.

### `antidrift/no-defensive-shape-probing` — sunset condition

- Intended value: broad-value mini-parsers probing `any`/`unknown` member-by-member claim type authority through weak local probing instead of the owning schema/converter.
- Problem kind: mostly owned by broader upstream rules on current evidence. The only real drift is `any`-typed and `@typescript-eslint/no-unsafe-member-access` reports its property reads in the same file; antidrift adds the callback-level grouping and replacement path, which has not yet proven distinct value. The predicate version of this failure is owned by `no-underchecked-type-predicate`.
- Evidence: one Chaski drift; clean controls in four repos; `pnpm policy:inventory-defensive-shape` checked 1,648 type-aware files, 72 syntax candidates, and found no second drift with 0 parser errors.
- Disposition: stays inventory/off. Sunset result is negative for second drift; retire and lock unless a new repo produces `unknown`-typed drift that upstream unsafe rules do not explain.

## Delegated Surface

Policy IDs from `policyRuleReviews` that antidrift deliberately does not implement as custom rules.

| Policy rule                                                                                                                        | Owner                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `react/no-derived-state-effect`                                                                                                    | `react-hooks/no-deriving-state-in-effects` (ecosystem)                                                               |
| `arch/no-cross-layer-import`                                                                                                       | `boundaries/element-types` (ecosystem)                                                                               |
| `arch/no-deep-import`                                                                                                              | `boundaries/no-private` (ecosystem)                                                                                  |
| `arch/no-new-dependency-cycle`                                                                                                     | `import-x/no-cycle` (ecosystem; custom `no-cycle` locked retired)                                                    |
| `errors/preserve-caught-error`                                                                                                     | ESLint `preserve-caught-error` (ecosystem)                                                                           |
| `test/no-only-or-skip`                                                                                                             | `no-only-tests` plus `@vitest/eslint-plugin` (ecosystem)                                                             |
| `test/no-conditional-expect`                                                                                                       | `vitest/no-conditional-in-test` (ecosystem)                                                                          |
| `test/no-test-without-assertion`                                                                                                   | `vitest/expect-expect` (ecosystem)                                                                                   |
| `policy/no-inline-disable-without-ticket`                                                                                          | `@eslint-community/eslint-comments/require-description` plus `@typescript-eslint/ban-ts-comment` (ecosystem; locked) |
| `perf/no-await-in-loop-with-io`                                                                                                    | ESLint `no-await-in-loop` (ecosystem baseline; IO narrowing only if real noise appears)                              |
| `boundary/no-sdk-direct-use-outside-gateway`                                                                                       | Generated `no-restricted-imports` from `gateways.yaml`                                                               |
| `gen/require-import-from-generated`                                                                                                | Generated `no-restricted-imports` from `generated.yaml`                                                              |
| `agent/block-generated-policy-edits`, `agent/block-destructive-shell`, `agent/lint-after-edit`, `agent/require-checks-before-stop` | Generated lifecycle hooks                                                                                            |
| `policy/no-check-weakening-without-policy-task`                                                                                    | `pnpm policy:check:changed`                                                                                          |
| `sonar/import-custom-eslint-issues`                                                                                                | `pnpm sonar:prepare`                                                                                                 |
| `rules/one-source-generates-agent-files`                                                                                           | `pnpm policy:check-generated`                                                                                        |
| `sonar/no-new-critical-issues`, `sonar/complexity-budget`                                                                          | SonarQube server gates (delegated)                                                                                   |
| `ts/no-mechanical-get-x-from-y`                                                                                                    | Merged into `ts/no-trivial-selector-wrapper` — the name was the symptom, the structure is the rule                   |

The SonarJS SQL note stands: `sonarjs/sql-queries` is tracked as ecosystem coverage, but the measured benchmark reports 0 findings against the custom rule's 16/31, so it is adjacent coverage, not a replacement.

## Retired (Locked)

Reopening any of these requires checker-lock changes plus new real-code evidence; see `decisionLocks` in `policy/registries/rules.yaml`.

| Rule                                     | Why it died                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-cycle`                               | Ecosystem owns import graphs (`import-x/no-cycle`).                                                                                               |
| `no-inline-disable-without-ticket`       | Descriptions are the maintainable policy; ticket strings were not.                                                                                |
| `no-sdk-direct-use`                      | Generated config from registry facts is simpler than custom code.                                                                                 |
| `no-explicit-return-type-private-helper` | Real code showed private return annotations are often legitimate contracts — the symptom was not a problem.                                       |
| `no-silent-catch`                        | Maintained rules cover the low-value surface; the real target is fallback-to-empty (research).                                                    |
| `no-thin-typed-factory-wrapper`          | No real non-test exact-forward drift; clean facades false-positive — the "only returns another call" framing was too broad.                       |
| `no-obvious-comment`                     | Comment restatement is review guidance, not deterministic lint.                                                                                   |
| `no-role-literal-in-type`                | Role words are too generic without canonical-model context.                                                                                       |
| `no-cast-to-branded`                     | No real forgery; the brand marker had no adoption.                                                                                                |
| `no-unsafe-cast-chain`                   | Upstream owns double-cast tunnels; `no-appeasement-cast` keeps the narrow boundary policy.                                                        |
| `no-status-triplet-state`                | Name groups inventory resource-state suspects but do not prove lifecycle drift; semantic proof lives in `no-handrolled-resource-lifecycle-cells`. |

## Research Only

Not implemented. Each needs ecosystem review plus real drift and clean controls before entering scope; spec-only rows are intentionally unenforced policy prose.

| Candidate                                                                                                                                                   | Real problem, if proven                                                                                                                    | Entry/drop condition                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `antidrift/no-same-schema-recertification`                                                                                                                  | Unearned re-certification: same-schema `parse({ ...typedOutput })` with no refinement or boundary value                                    | Leaning drop. Codebase Atlas anchors split owned-only vs cross-source; drop unless a second repo produces an accepted remediated anchor.                                                                                                                                                                                                                                                                                                           |
| `react/no-use-state-waterfall`                                                                                                                              | Same family as coupled setters/resource cohesion                                                                                           | Only after the coupled-setters inventory classification shows a residual gap.                                                                                                                                                                                                                                                                                                                                                                      |
| `react/no-effect-fetch-waterfall`                                                                                                                           | Data-loading architecture                                                                                                                  | Mostly pressured by `no-raw-fetch-in-component` plus React Hooks rules; needs proof of a residual gap.                                                                                                                                                                                                                                                                                                                                             |
| `errors/no-fallback-to-empty`                                                                                                                               | `catch` returning `[]`/`{}` silently converts failure into wrong data                                                                      | Top of the broad queue; needs a real-program matrix first. Origin complaint recovered 2026-06-10 from a Chaski session (default fallback rejected in favor of fixing the read path); the deep-archive pass found it recurring across Codex 2025/09–2026/04 and opencode, and the exhaustive sweep counted 24 swallow/fallback items plus 3 unnecessary-fallback-path complaints — the highest-recurrence unimplemented candidate by a wide margin. |
| `boundary/no-env-access-in-client`                                                                                                                          | Server secrets/config read in client bundles                                                                                               | Evaluate maintained config options against real client env reads.                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth/no-boundaryless-route`, `auth/no-client-only-authorization`                                                                                           | Authz family                                                                                                                               | Frozen until decision 7 (wrapper pattern) lands.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `perf/no-unbounded-promise-all`, `perf/require-timeout-for-network-call`                                                                                    | Unbounded fan-out; hanging network calls                                                                                                   | Need gateway-scoped construction patterns, not generic call scanning.                                                                                                                                                                                                                                                                                                                                                                              |
| `obs/no-fire-and-forget-without-tracking`                                                                                                                   | Untracked background work                                                                                                                  | Needs a concrete local tracking convention plus `no-floating-promises` overlap review.                                                                                                                                                                                                                                                                                                                                                             |
| `arch/no-one-use-helper`                                                                                                                                    | Fake abstraction                                                                                                                           | Reference counts alone over-report; needs a deterministic reformulation.                                                                                                                                                                                                                                                                                                                                                                           |
| Mined 2026-06-10: no `mocks/` imports in production code                                                                                                    | Test doubles leaking into prod bundles/behavior                                                                                            | Config-covered: `import-x/no-restricted-paths` (already installed) expresses directory zones directly, or generated `no-restricted-imports`; needs one real prod mock-import drift before wiring. No custom code.                                                                                                                                                                                                                                  |
| Mined 2026-06-10: raw color values outside theme tokens                                                                                                     | Inline hex/color literals bypass `theme.colors.*` — the non-Tailwind generalization of `no-raw-tailwind-color`                             | Per-platform owners exist: `eslint-plugin-react-native` v5.0.0 ships `no-color-literals`/`no-inline-styles` for RN; web CSS belongs to stylelint or the theme layer. Folds into the decision 8 control-layer call; do not build a separate rule first.                                                                                                                                                                                             |
| Mined 2026-06-10: tRPC procedures without `.output()` schemas                                                                                               | Response contracts left unowned at the boundary                                                                                            | Framework-specific; no maintained tRPC ESLint plugin found under common names (2026-06-10 registry check). Needs a Chaski procedure inventory and an owner pattern before any rule shape.                                                                                                                                                                                                                                                          |
| Mined 2026-06-10 (deep pass): domain literals outside the owner                                                                                             | Hardcoded ID prefixes and enum strings recur (8+ sessions) where a domain owner should hold the vocabulary                                 | Generalizes `no-status-literal-in-type` with the same registry-plus-AST machinery; needs registry-declared literal owners plus one real drift/clean pair. Not a generic magic-number rule. Exhaustive sweep: 17 recurrences.                                                                                                                                                                                                                       |
| Mined 2026-06-10 (deep pass): Zod schema forks                                                                                                              | Local `z.object` re-declares a shape an owner schema module already exports ("row-level zod schemas instead of reusing posthog-schema.ts") | Type forks are covered; schema-object forks are not. Registry check 2026-06-10: `eslint-plugin-zod` v4.7.0 (active) and `eslint-plugin-zod-x` are best-practice style rules with no documented structural schema comparison — still net territory. Signal: TypeChecker comparison of schema output types against owner schema exports; needs a second real fork and clean projection controls.                                                     |
| Mined 2026-06-10 (frustration pass): barrel files                                                                                                           | Re-export-only index modules bloat bundles, hide cycles, and defeat tree-shaking ("fucking barrel files", 2+ sessions)                     | Likely ecosystem-covered — verified 2026-06-10: `eslint-plugin-barrel-files` v3.0.1 ships `avoid-barrel-files`, `avoid-importing-barrel-files`, `avoid-re-export-all`, `avoid-namespace-import`; `eslint-plugin-no-barrel-files` v1.3.1 (updated 2026-04) also exists. Next step is a real-corpus benchmark of the plugin, not custom code.                                                                                                        |
| Spec-only: `arch/max-function-lines`, `arch/max-component-lines`, `ui/no-generic-ai-copy`, `obs/async-boundary-requires-context`, `sec/no-hardcoded-secret` | Various                                                                                                                                    | Owned by Sonar trends, maintained scanners, future policy scripts, or review guidance — not custom AST rules. Agent-ops config/runtime/doc candidates are tracked in the Agent-Ops Roadmap above.                                                                                                                                                                                                                                                  |

## Open Decisions, With Recommendations

These are the live grill questions reduced to recommended outcomes. Each changes rule surface, so confirm before executing.

1. **Status triplet**: closed. The redundant-constant-cell proof is folded into `no-handrolled-resource-lifecycle-cells`, and the standalone name-group rule is retired and locked.
2. **Broad-input authority blocking**: block only degenerate zero/near-zero-field authority claims; keep sufficiency-threshold findings as inventory. Recommended: yes.
3. **One-owner forks**: projected boundary DTOs at real translation boundaries are clean. Installed-package blocking requires accepted package-owner facts, ideally proposed from analytics such as existing imports, `Pick`/`Omit` derivations, SDK return provenance, or repeated structural forks. The unconfigured all-`node_modules` sweep stays inventory/discovery for finding owners worth accepting. Recommended: yes.
4. **SQL severity split**: value interpolation blocks everywhere; dynamic identifier interpolation downgrades to inventory when parser services are absent, and type-proof is never replaced with name exemptions. Codified through `parserServiceDeltas`.
5. **Nullable tuples**: nullability stays the policy boundary. Recommended: yes (already the rule's shape).
6. **Async arrays**: never-await methods may promote on deterministic evidence plus the one real drift; `map`/`flatMap`-not-collected keeps a separate evidence gate. Recommended: yes.
7. **Authz**: move from absence detection toward typed policy-wrapper registration as the construction pattern; freeze the current Express-scope rule until then. Recommended: yes.
8. **Design-system class strings**: the theme/design system making raw utilities unconstructable is the primary control; lint stays as an honestly-scoped backstop. Recommended: yes.

## Next Slices

1. Find real deterministic resource-lifecycle drift for `no-handrolled-resource-lifecycle-cells`; broad seven-repo co-mutation is classified inventory and the deterministic lifecycle branch is already the blocking core.
2. Find independent generated-source replication and real accepted package-owner evidence for `no-structural-type-fork`; the unconfigured installed-package sweep is now analytics/inventory.
3. Keep `no-defensive-shape-probing` as explicit default-off inventory; do not spend promotion work there unless new broad-value drift appears.
4. Run adversarial review for `no-canonical-model-fork` against Chaski plus Sudocode evidence; keep `no-underchecked-type-predicate` default-off while seeking real required-field drift.
5. Decide 8 (theme vs lint) before further design-system promotion work.
6. Decide 7 (authz wrapper pattern); no authz widening before that.
