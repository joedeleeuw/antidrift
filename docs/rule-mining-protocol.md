# Rule Mining Protocol

Last updated: 2026-06-13.

One protocol, two products. Mining work history recovers (1) lint/policy rule candidates for this package and (2) repeated manual workflows worth packaging as skills, subagents, or automations. Both share the same evidence order and candidate gates; they differ only in the form menu. This operationalizes investigation-flow step 2 in `docs/rule-status-registry.md` — recover the original complaint — at inventory scale, instead of designing rules from syntax.

## Evidence Order

1. **Local agent history stores.** All of these exist on this machine. Grep transcript stores only with bounded match windows (`-o`, a capped `[^"\\]{0,130}` window, `-m` per-file limits) because transcript lines are megabyte-scale JSON, and exclude this repo's own sessions when hunting origin complaints.

   | Store                | Location                                                                                            | Notes                                                                                                                                                                             |
   | -------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Claude Code sessions | `~/.claude/projects/<project>/*.jsonl`                                                              | MCP `search_session_transcripts` needs a supervised session; the grep fallback always works.                                                                                      |
   | Codex rollouts       | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` plus `~/.codex/archived_sessions`                    | Roughly 8 GB; restrict by month before sweeping.                                                                                                                                  |
   | Codex Memories       | `~/.codex/memories/`: `MEMORY.md`, `raw_memories.md`, `memory_summary.md`, `rollout_summaries/*.md` | Highest signal-to-noise — titled per-session summaries; read directly instead of windowed grepping.                                                                               |
   | opencode             | `~/.local/share/opencode/opencode.db` (SQLite) plus `project/<dir>/`                                | Drizzle-managed db: `session`/`message`/`part` tables, user text inside the `message` JSON `data` column (~20.8k messages). Query with `sqlite3 -readonly` plus `LIMIT`/`substr`. |
   | Gemini CLI           | `~/.gemini/history/<project>`                                                                       | Verified 2026-06-10: holds only `.project_root` markers, no transcripts.                                                                                                          |
   | Cursor, pi           | `~/.cursor/ai-tracking`, `~/.cursor/plans`, `~/.pi/agent`                                           | Present but unverified formats; probe before use.                                                                                                                                 |

   Example probe, identical for Claude and Codex stores:

   ```bash
   rg -i -o -m 2 'we should (never|always|stop|not|add|make|have|use)[^"\\]{0,130}' \
     ~/.codex/sessions/2026/06 -g 'rollout-*.jsonl' | head -50
   ```

2. **Codex Memories and rollout summaries first** when hunting repeated cross-session patterns — that layer already aggregates sessions (for example `antidrift_promote_selector_wrapper_stable.md` and `chaski_real_program_validation_gate_correction.md`), which is what the packaging prompt's evidence order assumes.
3. **Chronicle, if enabled** — discovery only; confirm details in the source system.
4. **Repo evidence**: `docs/handoff.md`, `reports/`, `docs/rule-investigations/`, the registries.
5. **Real corpora** under `/Users/sushi/code` (Chaski, Codebase Atlas, Sudocode, ...) to confirm the complaint exists in real code, not just in conversation.
6. **Existing surface, before creating anything**: active rules and `decisionLocks` in `policy/registries/rules.yaml`, the shared ESLint config, hooks, policy scripts, and existing skills/automations. Reuse or extend; locked decisions do not reopen via mining.

## Search Probes

Complaint language is the signal: "we should (never|always|stop|add|use)", "stop doing", "instead of", "already exists", "source of truth", "lint rule", "net new", "why did you", and all-caps corrections. Frustration markers are equally reliable for this user: the fuck-family ("fuck", "fucking", "wtf", "jfc"), "dude", "god damn", "why do we need", and "keep adding". Measured effectiveness (2026-06-10 pass): fuck-family plus "dude" and "why do we need"/"keep adding" are high signal; "omg"/"ugh"/"pls" and keyboard-mash ("asdf") are noise — drop them from future batteries. Prefer the user's own words over agent restatements when both appear.

## Candidate Gates

Act on a mined candidate only when it:

- occurred at least twice across sessions, or once plus real-repo replication, or is clearly recurring and costly to repeat;
- names a real failure — a problem in itself or a provable deeper failure — rather than a style irritation;
- has a stable signal candidate: AST, scope, TypeChecker, registry, or hook context for rules; stable inputs, a repeatable procedure, and a clear stopping condition for workflows;
- is not already adequately covered by an active rule, ecosystem rule, generated config, hook, policy script, locked decision, or existing skill/automation;
- generalizes beyond one codebase's business domain: a complaint that only makes sense inside Chaski's domain (discounts, promos, service stops, business dates) is at most evidence for a general failure mode, never a rule of its own.

## Truth Artifact Gate

Classify the proof surface before choosing a product form. The truth artifact is the smallest stable artifact that can prove the failure without guessing from the complaint. Candidate form is derived from this gate; do not choose "lint rule" first and then search for a signal.

| Truth artifact                     | Owner layer                        | Candidate form                                                                                  |
| ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `source AST`                       | deterministic lint                 | custom ESLint rule, ecosystem rule wiring, or generated config                                  |
| `source+TypeChecker`               | semantic lint                      | type-aware rule research or existing type-aware ecosystem rule                                  |
| `source+registry`                  | semantic lint / policy registry    | registry-backed rule, generated config, or policy script                                        |
| `class-string+theme`               | design-system control              | ecosystem/config first; custom class-string rule only after residual gap proof                  |
| `diff+task+graph`                  | change-relative / repo-graph proof | policy script, diff-relative inventory, repo-graph signal, workflow automation, or hook adapter |
| `transcript+commands+verification` | agent-ops telemetry                | hook, telemetry, workflow automation, or skill                                                  |
| `runtime/device`                   | runtime validation                 | smoke test, e2e check, workflow automation, or skill                                            |
| `none`                             | advisory                           | skip, docs, skill, or human review guidance                                                     |

Hard invariant: plain ESLint-rule form is legal only for `source AST`. A rule implemented in the ESLint runtime can still belong to `semantic lint` when it needs TypeChecker, registry, class-token, or theme context. Anything whose proof surface includes diff scope, task intent, repo graph, transcript text, command history, verification output, runtime state, or device behavior is barred from lint-rule form.

Seed classifier rows:

| Failure mode                      | Provenance                                                                                                                                 | Truth artifact                     | Owner layer                                | Candidate form                                             | Evidence still needed                                 | Disposition    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| Diff-scope creep                  | Frustration pass 2026-06-10: "why are you changing so much fucking code dude"; "dude the diff is like 200 lines"; "why do we need"         | `diff+task+graph`                  | change-relative proof                      | Policy-script or diff-relative inventory research          | Changed-line/task-scope baseline and clean controls   | form-bucket    |
| Skip-verification before done     | Exhaustive sweep 2026-06-10 grouped `skip-verification` under agent-behavior complaints                                                    | `transcript+commands+verification` | agent-ops telemetry                        | Hook, telemetry, or skill                                  | Quote-backed windows plus command/verification traces | needs-evidence |
| Net-new bias as behavior          | First harvest 2026-06-10: "We should use `SettingsService` instead since it's already imported"; "we should have helpers for this already" | `diff+task+graph`                  | repo-graph proof, change-relative backstop | Owner-index, repo-graph, or diff-relative inventory signal | Existing-owner discovery baseline against repo graph  | form-bucket    |
| `catch` returning `[]` or `{}`    | Deep harvest 2026-06-10: "why are we setting a fallback?"                                                                                  | `source AST`                       | deterministic lint                         | Custom ESLint research row                                 | Real-program drift/control matrix                     | form-bucket    |
| Domain literals outside the owner | Deep harvest 2026-06-10: "we should not hardcode the `868862LN86` prefix"                                                                  | `source+registry`                  | semantic lint / domain registry            | Registry-backed semantic lint                              | Declared literal owners plus drift/control pair       | form-bucket    |
| Zod schema fork                   | Deep harvest 2026-06-10: "row-level zod schemas instead of reusing posthog-schema.ts"                                                      | `source+TypeChecker`               | semantic lint / type contracts             | Type-aware semantic lint                                   | Second real fork and clean projection controls        | form-bucket    |
| Barrel files                      | Frustration pass 2026-06-10: "fucking barrel files"                                                                                        | `source AST`                       | deterministic lint                         | Ecosystem rule wiring benchmark                            | Real-corpus plugin benchmark                          | form-bucket    |
| Raw color or off-token utilities  | First harvest 2026-06-10: "inline hex colors that should reference `theme.colors.*` or CSS variables"                                      | `class-string+theme`               | design-system control                      | Ecosystem/config or advisory before custom lint            | Theme-owner coverage and residual gap proof           | form-bucket    |

Rows graduate out of this intake table when they become active rules, roadmap research rows, hooks, scripts, or skills. The live implementation status belongs in `policy/registries/rules.yaml`, `docs/rule-roadmap.md`, or the owning workflow artifact, not in this table.

## Smallest Appropriate Form

- **Rule products**: derived from the truth artifact gate: custom ESLint rule, semantic lint, ecosystem rule wiring, generated config, hook, policy script, inventory-only signal, research row, or skip — the same buckets as `docs/rule-roadmap.md`.
- **Workflow products**: skill, custom subagent, automation, extend-existing, or skip.

## Output Contract

First produce a compact shortlist: the complaint in the user's words, evidence locations and dates, sampled rank or confidence, truth artifact, derived owner layer, derived candidate form, and why it is or is not worth creating. Then create only the high-confidence missing items — for rules that means a research row carrying the six roadmap fields, not an implementation; real-corpus gates still control promotion. Finish with what was created or extended, what was deliberately skipped, and what needs more evidence.

Item caps are elastic: they exist to force ranking, not to truncate value. If a pass hits its cap and the remainder are keepers, keep going.

## First Harvest (2026-06-10)

Bounded grep passes over `~/.claude/projects` and `~/.codex/sessions` (May–June 2026), excluding this repo's sessions.

| Complaint (user's words)                                                                                                                | Where                                                        | Maps to                                          | Disposition                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| "we should use PowerSyncService, not both with a fallback. This creates confusion about which is the source of truth."                  | `chaski/60124227`                                            | Net-new bias / one-owner thesis                  | Origin evidence; no new rule.                                                                                        |
| "We should use `SettingsService` instead since it's already imported"; "we should have helpers for this already"                        | `chaski/4624950b`; `chaski-src-frontend-monolithui/e8df0189` | Net-new bias / one-owner family                  | Origin evidence; no new rule.                                                                                        |
| "we should not add a default fallback for those scoped stops. We need to fix the scoped local data/read path."; "WE SHOULD NOT DO THIS" | `chaski-app/c2f03acb`                                        | `errors/no-fallback-to-empty`                    | Provenance recorded on the research row in `docs/rule-roadmap.md`.                                                   |
| "Lint rule: no imports from `mocks/` directory in production code"                                                                      | `precheck-db-full-restart/7c72097c`                          | Generated `no-restricted-imports`                | New research row; generated-config form, needs one real prod mock-import drift.                                      |
| "consider adding a custom rule or lint task to flag inline hex colors that should reference `theme.colors.*` or CSS variables"          | `precheck-db-full-restart/b1d4fbab`                          | Design-token family                              | New research row; the non-Tailwind generalization of `no-raw-tailwind-color`, folds into the control-layer decision. |
| "we should add `.output()` schemas especially for:"                                                                                     | `chaski/5ec446a4`                                            | Boundary contract ownership                      | New research row; framework-specific tRPC output-contract candidate, needs procedure inventory.                      |
| disable `@typescript-eslint/no-unsafe-return` plus `as z.infer<TZodType>` workaround                                                    | `chaski/31b991a0`                                            | `no-appeasement-cast`, disable-description rules | Origin evidence; covered.                                                                                            |
| "setstate removal, why, what we should..." follow-up work                                                                               | `murderbox-apps-client-app/1461e3a8`                         | React state cohesion family                      | Origin evidence for the confirmed coupled-setters fold.                                                              |
| "ESLint rules for agent-authored TypeScript"; Steve Kinney Enterprise UI ESLint notes; typed rules via `getParserServices`/TypeChecker  | `-private-tmp/43d76a3e`                                      | Project origin                                   | The research session that seeded antidrift; keep as provenance.                                                      |
| "we should use existing design system elements right? i.e not carving out disparate UI"                                                 | Codex `2026/05/19` rollout (nidus)                           | Net-new bias, design-system dimension            | Origin evidence; supports the decision 8 control-layer framing.                                                      |
| "we should not make 'Oxlint JS plugin only' the core strategy."                                                                         | Codex `2026/05/31` and `2026/06/04` rollouts                 | Engine decision                                  | Provenance for the ESLint-only decision; already executed and locked in the handoff.                                 |

Skipped this pass: ghostty "we should never get these" (domain-specific invariant, not lint scope); hardcoded `/tmp` path complaint (`chaski-sibling/9952828e`, single occurrence, ecosystem/Sonar overlap unchecked); Zod `.coerce`/`.transform()`/`z.string().datetime()` guidance (construction-pattern docs, not rules).

## Deep Harvest (2026-06-10, full-archive pass)

Four parallel readers covered the Codex Memories layer in full (35 summaries plus `MEMORY.md`/`raw_memories.md` — coverage starts 2026-05-24; the Memories feature is recent), Codex rollouts 2025/08–2026/04, Claude projects with an extended probe battery, and the opencode/Gemini stores. Richest months: April 2026 (reuse complaints), March 2026 (schema/boundary), February 2026 (hardcoding), September–December 2025 (error swallowing, casts).

### Validates existing rules and queue ranks

| Recovered complaint                                                                                                  | Recurrence                                | Strengthens                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Silently swallowed errors; "why are we setting a fallback?"                                                          | Many, Codex 2025/09–2026/04 plus opencode | `errors/no-fallback-to-empty` — now the highest-recurrence unimplemented candidate.         |
| "as any" / "as unknown as Response" corrections; "derive types from `AppRouter` with `inferRouterInputs/Outputs`"    | Many                                      | `no-appeasement-cast` and the type-aware baseline.                                          |
| Stale generated clients "pretending there's still a separate schema lineage"; duplicate portal/BFF codegen           | 2+ each                                   | `no-structural-type-fork` generated mode; `gen/require-import-from-generated`.              |
| "duplicate typedef instead of importing"                                                                             | 2+                                        | One-owner fork family.                                                                      |
| New `ChaskiButtonColor` palette instead of the shared system; hardcoded colors vs tokens across web, RN, and Flutter | 2+ in three ecosystems                    | Design-token family and the decision 8 control-layer call.                                  |
| "error state active outside useEffect"; "loading state still active when data already loaded"                        | 2+                                        | The confirmed coupled-setters derivability fold — these are the field failures it prevents. |
| "keep adding helper functions when typed payloads already have all fields"                                           | 2+                                        | `no-trivial-selector-wrapper` (stable).                                                     |
| Duplicate component trees under `modules/scenarios` and `modules/scenarios/wizard`                                   | 1                                         | `arch/no-feature-scatter` stays spec-only, with provenance.                                 |
| Hardcoded credentials path                                                                                           | 2+                                        | `sec/no-hardcoded-secret` stays delegated to scanners.                                      |
| Cross-file duplicate logic ("performance discount amount in 3 locations", "consolidate into a utility")              | Many, three stores                        | Sonar-delegated duplication detection; not custom AST scope.                                |

### New research rows (gates passed)

| Candidate                                                                   | Evidence                                                                                                                                 | Why it qualifies                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Domain literals outside the owner (generalizes `no-status-literal-in-type`) | "we should not hardcode the `868862LN86` prefix" recurs 8+ times across Codex 2025/11–2026/04; hardcoded enum strings in Claude sessions | Registry-plus-AST machinery already exists; the failure is owner vocabulary spread, not magic numbers in general.                        |
| Zod schema fork                                                             | "row-level zod schemas instead of reusing posthog-schema.ts" (`chaski bff-lint-zod` session, 2+); monolithui mapper duplication          | Type forks are covered; schema-object forks are not. Signal: TypeChecker comparison of schema output types against owner schema exports. |

### Hook/workflow candidates

- Diff-scope creep guard — "why do we need 100 more lines of code?", "why are you changing so much fucking code dude" recur across months. Change-relative policy-script research (changed-lines budget vs task scope), not ESLint.
- Expo native-adoption audit and EAS build-failure diagnosis (2 sessions each) — real repeated workflows, but they belong to Murderbox tooling, not this package.
- Real-corpus rule-promotion gate — already exists as this repo's policy scripts; extend-existing, no action.

### Skipped, with reasons

- Review-judgment cluster (speculative abstraction, tests coupled to implementation, Flutter cross-layer consistency) — no deterministic signal; matches the locked `no-thin-typed-factory-wrapper` lesson.
- "instead of reusing PR-writing patterns" (100+ identical hits) — template/system-prompt text recurring in transcripts, not human complaints. Lesson for future passes: treat high-recurrence identical phrasing as noise-suspect.
- React Native inline styles (many) — `eslint-plugin-react-native` territory; consumer tooling, not this package.
- Memories-layer native/build one-offs (DEBUG-guarded imports, brittle plugin matching) — real but session-specific; not lint scope.

### Probe gaps for the next pass

"keep adding", "why do we need", and over-engineering complaints are under-captured by the current battery. Add probes: `keep adding[^"\\]{0,120}`, `why do we need[^"\\]{0,120}`, `so much .{0,20}code`. (Run 2026-06-10 in the frustration pass below — both confirmed high-signal.)

## Frustration-Probe Pass (2026-06-10)

Three readers re-ran all three minable stores (Codex 2025/08–2026/06, Claude projects, opencode SQLite) with the exasperation battery, elastic caps, and the generalizability gate.

### Confirmed and strengthened

| Finding (user's words)                                                                                                                                                                          | Recurrence                | Effect                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "god damn it with the any's"                                                                                                                                                                    | Many, two Chaski sessions | `no-appeasement-cast` and type-aware baseline provenance — the user corrects this repeatedly.                           |
| "dude what the fuck is this? ... two safer alternatives than widening to unknown" (server-component boundary)                                                                                   | 1, Codex 2025/09          | Broad-input type authority family provenance with the preferred patterns stated in the complaint itself.                |
| "if we have zod why do we need to do all of this inline validation"                                                                                                                             | 1                         | Validation-boundary/parse-at-edge provenance: delegate to the owning schema.                                            |
| "dude you are literally adding duplicates, i didn't say to add new tokens"; "this config file has the same constants defined 5 ways till sunday"                                                | 2+ each                   | Design-token decision 8 plus the domain-literal-ownership research row.                                                 |
| Feature flags read via a singleton service everywhere instead of passed as parameters                                                                                                           | High, opencode            | The gateways pattern: generated `no-restricted-imports` with thin-wrapper overrides already models this.                |
| Dead model fields surviving proto/codegen changes                                                                                                                                               | High, opencode            | Generated-source drift family provenance (stale-after-owner-change is the same failure as forking).                     |
| Diff-scope creep: "why are you changing so much fucking code dude"; "dude the diff is like 200 lines"; "i don't want the god damn churn, so unfucking do it"; "why do we need" (15+ variations) | Many, all three stores    | Promoted to a named change-proof research row — the highest-recurrence complaint in the archive after error swallowing. |

### New research row

- **Barrel files**: "fucking barrel files" (2+ sessions, bundle-size context). Re-export-only index modules bloat bundles, hide cycles, and defeat tree-shaking. Deterministic AST candidate; check `eslint-plugin-barrel-files` and generated `no-restricted-imports` coverage before any custom work.

### Skipped, with reasons

- Follow-repo-convention complaints ("just fucking initialize the flags like the other ones", "idiomatic, look at the god damn template") — real and recurring, but no deterministic signal; agent-instructions territory, not lint.
- Cross-callsite feature-flag guard consistency (opencode, high recurrence) — needs whole-program analysis; beyond local ESLint determinism; Sonar/review territory.
- "remove descriptive comments" recurrence — noted, but `no-obvious-comment` stays locked retired; transcript complaints are provenance, not the real-code evidence the lock requires to reopen.
- Module-coupling and over-abstraction judgments ("you don't see how these could be entirely independent", "you are an idiot" simple-href case) — feed the diff-scope change-proof candidate, not a syntax rule; matches the locked `no-thin-typed-factory-wrapper` lesson.
- Unused imports/variables/unreachable switch arms — ecosystem baseline already owns these.
- Dart/Flutter analyzer territory (mixin lifecycle order, unimplemented widget methods, null-style consistency) — consumer tooling.
- Prose/tone complaints ("so many words dude, one line") — communication style, not code.

### Probe effectiveness (measured)

| Probe                                   | Verdict                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| fuck-family (`fuck\|fucking\|wtf\|jfc`) | High signal — best single battery.                                |
| `dude`                                  | Medium alone, high when co-occurring with fuck-family.            |
| `why do we need` / `keep adding`        | High — captures over-abstraction complaints no other probe finds. |
| `god damn`                              | Medium.                                                           |
| `please (stop\|just)`                   | Workflow redirects, occasionally useful.                          |
| `omg\|ugh\|argh\|smh`                   | Noise.                                                            |
| `pls`                                   | Noise (matches headers/requests).                                 |
| `asdf` keyboard-mash                    | Zero signal — retire.                                             |
| `stupid\|wrong again`                   | Near zero in Codex, occasional in Claude.                         |

### Targeted probes: "inference", "RL", "fighting" (2026-06-10)

- **"fighting"** is almost entirely agent commentary marking workaround spirals ("instead of fighting quoting/the harness/the TUI/minified output"); one user-voiced hit: "do an npm install you are fighting the worktree it looks like". Signal: a workflow marker for step-back heuristics, not lint.
- **"RL"/"RLHF"**: zero complaint signal. Two-letter uppercase probes match base64 blobs heavily — future short-token probes need surrounding-prose context or a filter for long alphanumeric runs.
- **"inference"**: dominated by antidrift's own Codex sessions — the Codex store has no per-project layout, so unlike the Claude store it cannot be path-excluded; exclude this repo's sessions by content when it matters. One real provenance find: a Chaski comment "Cast to any to work around tRPC type inference issues in this project" — an appeasement cast with a confession comment, feeding `no-appeasement-cast`.
- Model-stubbornness complaints exist in the archive but use repeated-correction phrasing ("god damn it with the any's", "WRONG again", "no shortcuts, please stop giving up"), not RL vocabulary.

## Exhaustive Sweep (2026-06-10)

The full-archive classification run, with no sampler caps: 13,744 deduplicated windows from 8 probes across Claude, Codex, and opencode → 23 Haiku chunk-classifiers plus Sonnet reducers/synthesis (27 agents, ~2.6M subagent tokens, ~10 minutes) → 545 keeper items grouped into 97 distinct failure modes. Raw output: `reports/complaint-sweep-2026-06-10.json`. Only 7 items were Chaski-domain-only after the generalizability gate.

### Recurrence by existing family (top of 23)

| Family                             | Items                 | Note                                                                                                                            |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| duplication (Sonar-delegated)      | 31                    | Delegation verdict holds; recurrence is high but cross-file duplication is CPD territory.                                       |
| one-owner-fork                     | 28                    | "source of truth" complaints; the project thesis, confirmed at volume.                                                          |
| redundant-zod-parse / schema forks | 25                    | Includes inline schema redefinitions merged by the reducers.                                                                    |
| error-fallback-or-swallow          | 24 (+3 fallback-path) | `errors/no-fallback-to-empty` stays the top unimplemented candidate by a wide margin.                                           |
| underchecked-predicate             | 18                    |                                                                                                                                 |
| domain-literals/magic-values       | 17                    | Strengthens the mined research row.                                                                                             |
| test-integrity                     | 15                    | Mostly review-judgment shapes (mocked-instead-of-real, pointless fixtures).                                                     |
| abstraction-and-file-shape         | 14                    | Absorbed trivial-wrapper variants.                                                                                              |
| raw-fetch-boundary                 | 13                    | Includes "why the fuck is there axios in the BFF" — the first non-fetch raw-transport evidence the stable card was waiting for. |
| import-hygiene / barrel            | 13                    |                                                                                                                                 |
| feature-scatter                    | 13                    | Highest-recurrence spec-only architecture signal.                                                                               |
| generated-drift                    | 12                    |                                                                                                                                 |
| react-state                        | 10                    |                                                                                                                                 |

### New-candidate triage: everything folds

None of the 15 new-candidate groups passes the gates as a new rule row; each folds into an existing row or the repo/session proof layer: unnecessary-fallback-path → `no-fallback-to-empty`; multi-pass-parsing → validation-boundary / same-schema-recertification; over-calling-apis → effect-fetch-waterfall research; unjustified-complexity, unnecessary-service-layer, and idiomatic-pattern-not-followed → the diff-scope/net-new change-proof cluster; unnecessary-fixture-setup → test-integrity guidance. Below-gate singles stay noted in the report only (config-as-code, destructuring-clarity, prevent-instead-of-instrument). All `generalizable=false` items were Chaski-specific tooling.

### The real finding: the repo/session proof layer dominates

Roughly 225 of the 545 keepers are agent-behavior complaints, not lintable syntax. Taxonomy by recurrence: diff-scope-creep 60, net-new-bias-as-behavior 25, general agent-behavior 21, incomplete work 18, skip-verification 9, over-automation 6, env-management 6, error-handling protocol 5, scope-drift 5, instruction-skipping 5, plus 15 smaller modes (full list in the report). The archive's verdict: the package's repo/session proof surface — diff-relative checks, repo-graph checks, and narrow agent-ops hooks where session facts are required — is where the next marginal value lives.

### Measured sampler coverage

Every pass so far is a sampler, not a sweep: probes ran with per-file match caps (`-m 2`/`-m 3`) and head-capped output (~40-60 windows per probe). Measured denominators (2026-06-10): Claude "we should" family 367 matches across 125 files, fuck-family 732 across 170; Codex "we should" 8,338 across 362 files, fuck-family 7,255 across 381, over 1,773 rollout files total. Sampled coverage of those two probes alone is a few percent. An exhaustive sweep must extract all windows per probe to working files and classify them in batches; do not claim archive exhaustion from sampler passes.
