# Antidrift Research Learnings — 2026 Pass

Distilled, cited learnings from the 2026 antidrift research pass: the whitepaper market/literature survey, the opus-4-8 architecture review, three rule investigations, the solve-bucket taxonomy, and two independent lifecycle-proof external reviews (codex-out.md, opencode-out.md). Each learning is flagged to the antidrift rule(s) it changes. Rule IDs are drawn from `policy/registries/rules.yaml` and `policy/registries/solve-buckets.yaml`.

---

## Learnings

**1. The lifecycle proof rewrite fixed two mis-shaped value-class requirements but remains under-proven**

Real catch blocks store a derived error code or message (`setErrorCode("DATA_INVALID")`, `setErrorCode(deriveCode(err))`), not the raw caught-error parameter. Real payload cells receive a member of the awaited object (`setData(resp.items)`), not the bare awaited value. The fixed `lifecycleProof` now accepts catch-scope error setters and first-level awaited source-member payload setters, while updater setters invalidate the proof to keep pagination clean.

Basis: `docs/rule-investigations/no-handrolled-resource-lifecycle-proof-rewrite.md` §2-4; corroborated by both external reviewers (codex-out.md §2a; opencode-out.md §2a). Current fixed-proof measurement: 1,533 Chaski frontend files, 100 broadSetterCoMutation inventory facts, and 2 resourceLifecycleProof diagnostics.

Applies to:
- `antidrift/no-handrolled-resource-lifecycle-cells` — **proof rewrite implemented, still default-off**. Next proof work is not another adapter rewrite; it is second-repo validation plus human review of the 2 Chaski positives and clean controls.

---

**2. Real catch blocks store derived error codes, not the raw caught error**

`setError(err)` is not the pattern in production React code. Developers call `setErrorCode("DATA_INVALID")` or `setErrorCode(deriveCode(err))`, returning `"other"` from `classifyWriteValue`. Any rule that requires `caughtError` (the raw catch-param identifier) to trigger enforcement will miss 100% of real occurrences.

Basis: `docs/rule-investigations/no-handrolled-resource-lifecycle-proof-rewrite.md` §2 bullet "errorCell"; codex-out.md §2a (`classifyWriteValue` r-s-g.js:50-52 returns `"other"` for derived values).

Applies to:
- `antidrift/no-handrolled-resource-lifecycle-cells` — implemented by recording catch-scope setter writes and accepting any owned catch-scope setter as the errorCell signal.

---

**3. Real payload cells receive members of the awaited object, not the bare awaited value**

`setData(result)` (bare awaited) is synthetic. Production code writes `setData(resp.items)`, `setRows(report.rows)`. The adapter already tracks these as `sourceMemberWrites` (react-state-graph.js:311-318) for the shard rule — but the lifecycle proof never consults `sourceMemberWrites`, only the `awaited` write-class. Broadening payloadCell to accept either path requires no new detector, just a proof-layer change.

Basis: `docs/rule-investigations/no-handrolled-resource-lifecycle-proof-rewrite.md` §3 (payloadCell bullet); opencode-out.md §2b payloadCell definition; codex-out.md §2b "payloadCell — broaden to accept members."

Applies to:
- `antidrift/no-handrolled-resource-lifecycle-cells` — implemented by using `frame.sourceMemberWrites` in the payloadCell check, with updater setters invalidating enforcement to preserve pagination.
- `antidrift/no-shattered-ingested-entity-state` — informational: the `sourceMemberWrites` infrastructure is shared; the shard rule already consumes it correctly. This learning confirms the adapter substrate is sound; the shard rule's problem is corpus evidence, not adapter shape.

---

**4. The shard rule found zero real owned-entity shatters across two repos; the pattern is an agent-authored hypothesis**

A type-aware scan of 335 components (chaski) and a wider AST scan across two repos (chaski, sudocode) found zero instances where an accepted domain/generated owned entity's fields were split across sibling `useState` cells. Every hit was a response envelope, value object, or computed-result split — patterns the rule correctly ignores via `sourceShardOwnedEntityProof`. The enforcing tier was removed; the rule is now inventory-only.

Basis: `docs/rule-investigations/no-shattered-ingested-entity-state.md` §Current Evidence ("No real-corpus enforcement positive yet"); `docs/rule-investigations/no-shattered-type-owner-tier-spec.md` header note ("SUPERSEDED — zero real human-authored owned-entity shatters"); `rules.yaml` antidrift/no-shattered-ingested-entity-state concerns block; codex-out.md §3a; opencode-out.md §3a.

Applies to:
- `antidrift/no-shattered-ingested-entity-state` — **do not promote; stay inventory-only**. The enforcement tier must not be rebuilt until a real agent-generated corpus produces ≥1 confirmed owned-entity shatter (where the awaited source resolves to an accepted domain/generated type and the members are typed props of that owner). Promotion additionally requires envelope/pagination/view-state clean controls from ≥2 repos (`rules.yaml` promotionRequirements.stable.minIndependentRepositories: 2).

---

**5. Synthetic-first test design is backwards; real corpus must precede enforcement**

Both React-state rules were shipped on synthetic RuleTester fixtures without measuring real corpora first. The lifecycle rule's only passing fixture is a shape that does not exist in 1,533 real files. The principle: synthetic tests are wiring guards (regressions against chosen shapes), not evidence that the shape occurs in real code. Evidence order must be: real corpus scan → measure signal → determine proof → write fixtures that capture real drift.

Basis: `docs/rule-investigations/no-handrolled-resource-lifecycle-proof-rewrite.md` §1 ("real-corpus-first, multi-repo baseline, synthetic tests are a wiring guard not evidence"). This lesson is explicit in the investigation as a committed decision (`064142a`).

Applies to:
- `antidrift/no-handrolled-resource-lifecycle-cells` — the rewrite is validated against Chaski and found 2 fixed-proof diagnostics, not 102. Promotion now requires ≥1 second repo per `promotionRequirements.stable` plus review of the Chaski positives.
- `antidrift/no-shattered-ingested-entity-state` — the existing `nextAction` in `rules.yaml` mandates an agent-generated corpus before any enforcement tier rebuild.
- All `under-proven` rules — the lesson is general: no rule moves from `under-proven` to `error` on synthetic fixtures alone.

---

**6. Diff-scope-creep, duplication, and net-new-bias are the measured industry-scale signature of agent-authored code**

Google's 2025 DORA report measured a 154% increase in PR size with 90% AI adoption rise. GitClear's 153M-line longitudinal study found code duplication up 4x, 2024 as the first year copy/paste exceeded moved code. GitHub's January 2026 study ("More Code, Less Reuse") confirms agents add redundancy per change while the surface "looks clean." The antidrift internal sweep (545 keeper complaints) maps to the same distribution: diff-scope-creep n=60, duplication n=31, one-owner-fork n=28, net-new-bias n=25.

Basis: `docs/whitepaper-agent-code-drift-proofs.md` §0 (thesis paragraph citing DORA 2025, GitClear, GitHub Jan 2026, AIDev dataset arXiv:2601.17581); `docs/solve-bucket-architecture-review.md` §2 behavior table.

Applies to:
- `antidrift/no-canonical-model-fork`, `antidrift/no-structural-type-fork` — these partially address duplication/one-owner-fork for declared owners, which is correctly placed. Their limit is that they cannot discover NEW duplicate owners (see Learning 7). No rule change; confirms current priority.
- Gap `duplication` + `one-owner-fork` (solve-buckets.yaml) — these need `clone-detection` bucket tools (NiCad, SourcererCC), not semantic-AST. Do not attempt to close these gaps with new ESLint rules.
- Gap `diff-scope-creep` (solve-buckets.yaml, n=60) — needs `diff-relative` bucket; no existing antidrift rule addresses it.

---

**7. The authority-index can only enforce declared owners; it cannot discover net-new duplicate owners**

`type-index.mjs` enumerates types through the shared TypeChecker Program (collectCanonicalTypes:130, program.getSourceFiles():106), but this is read-only type enumeration invoked per-file. It can ask "does this file's local type match a declared owner?" but never "is there already an undeclared owner for this concept elsewhere in the repo?" — which is the agent-specific question for net-new-bias.

Basis: `docs/solve-bucket-architecture-review.md` §2 Wall 1 (Per-file) and §3 candidate bucket (2) "promote owner discovery to a repo-graph proof"; `docs/whitepaper-agent-code-drift-proofs.md` §2.3 ("authority-index ownership today only enforces registry-declared owners, so it cannot catch the agent minting a new duplicate owner").

Applies to:
- `antidrift/no-canonical-model-fork` — correctly placed for registry-declared owners (solve-buckets.yaml: `fit: proven`). The note in solve-buckets.yaml is accurate: "Discovering NEW duplicate owners needs dependency-graph." No change to the rule; but net-new-bias enforcement requires a `dependency-graph` solve bucket, not an extension of this rule.
- `antidrift/no-structural-type-fork` — same limit; correctly placed for declared/generated owners; owner discovery is outside its structural scope.
- Gap `net-new-bias` (solve-buckets.yaml, n=25) — the correct mechanism is a whole-repo reflexion/uniqueness pass, not an extension of the per-file authority-index. Target: `dependency-graph` bucket.

---

**8. The three structural walls (per-file, intra-procedural, snapshot) make the plurality of measured complaints structurally unprovable by ESLint**

Verified in code: zero rules read another file, run git, or do inter-file iteration. The only whole-program reach is read-only TypeChecker enumeration in `type-index.mjs`. Every rule sees the current file state with no notion of what the commit changed. This means diff-scope-creep (n=60), net-new-bias (n=25), and silent-fallback (n=24) — the three largest unimplemented categories — are structurally outside the ESLint proof model, not simply missing rules.

Basis: `docs/solve-bucket-architecture-review.md` §2 (Three hard walls; verified cites: `git.mjs` and `changedFiles()` exist but used only in `cli.mjs:177,218`, never in a proof); `docs/whitepaper-agent-code-drift-proofs.md` §1 (table of behaviors vs walls).

Applies to:
- All `semantic-ast` rules — this is a statement about the whole proof layer. The semantic-AST surface is **saturating**: 6 stable, 11 stuck at `under-proven`, several default-off with zero blocking findings across thousands of files (architecture-review §5). Continued investment in new ESLint rules yields sharply diminishing returns for the measured behavior distribution.
- Gap `silent-fallback` (n=24) — do not attempt ESLint approximation of inter-procedural error flow; delegate to CodeQL/Semgrep (Learning 9).
- Gap `diff-scope-creep` (n=60) — do not use agent-ops hooks as a substitute; the whitepaper explicitly notes this is real proof on a diff baseline, not a hook/heuristic.

---

**9. Injection, deserialize, and authz rules are intra-procedural approximations of taint; the correct spine is delegation to a flow engine**

`antidrift/no-sql-string-concat` is an ~800-line god function in `index.js` (lines 1692-2488) that hand-rolls escaper-reachability with ~30 nested closures and a near-complete duplicate implementation over ESTree and `ts.*` simultaneously. This exists because SQL injection is a taint property that the intra-procedural model approximates. The same applies to `no-unsafe-deserialize` (parse-at-edge input provenance is an input-source property) and `require-authz-check` (authz reachability is a flow property). On JS, Joern scores F1 0.856 vs Semgrep's 0.081 on securibench-micro.js; LLM post-filtering cuts false positives from >92% to 6.3% (IRIS, ZeroFalse).

Basis: `docs/whitepaper-agent-code-drift-proofs.md` §2.4 (inter-procedural dataflow/taint section; Joern F1 0.856 vs Semgrep 0.081; IRIS arXiv:2405.17238; ZeroFalse arXiv:2510.02534); `docs/solve-bucket-architecture-review.md` §3 bucket (3) and §2 table row "Injection / value-reaches-sink"; `policy/registries/solve-buckets.yaml` (antidrift/no-sql-string-concat: `fit: approximation, target: dataflow-taint`).

Applies to:
- `antidrift/no-sql-string-concat` — stable but solve-bucket target is `dataflow-taint`. Do not hand-roll further; the architecture review recommendation is to delegate the 800-line escaper-reachability function to CodeQL/Semgrep and keep antidrift as the policy/fact/governance layer.
- `antidrift/no-unsafe-deserialize` — same: `fit: approximation, target: dataflow-taint` (solve-buckets.yaml). Stable as-is; the delegation path is the long-term direction.
- `antidrift/require-authz-check` — solve-buckets.yaml: `fit: proven, target: dataflow-taint`. The graph-config proof works today; reachability is the provable ideal.
- Gap `silent-fallback` (n=24, solve-buckets.yaml) — this is the clearest case for delegation; "does a caught error flow to a real sink or nowhere" is a taint query, not an AST shape.

---

**10. LLM judges must be triage, never the blocking proof; deterministic > probabilistic for blocking gates**

On OWASP Benchmark, CodeQL flagged 68% and Semgrep 75% of non-vulnerable cases. LLM post-filtering (IRIS, ZeroFalse) cuts FPs significantly but reintroduces a probabilistic component. The 2026 field consensus and capital allocation (CodeIntegrity $5M for deterministic guardrails) agree: deterministic static analysis and test-runners for everything machine-checkable; LLM-judge for genuinely semantic checks behind an explicit boundary, never as the blocking proof. All AI-code-review platforms (CodeRabbit, Checkmarx, LlamaFirewall) are LLM-judge/MCP/policy — not provable by definition.

Basis: `docs/whitepaper-agent-code-drift-proofs.md` §2.4 ("Two caveats for our adoption: … the LLM triage is precisely the probabilistic layer that must stay triage, never the blocking proof"); §3 (market gap table: AI code review = "no — LLM-judge, not provable"); GeekWire CodeIntegrity cite; jvaneyck 2026 cite.

Applies to:
- All antidrift rules — the existing design (frozen semanticFact contracts, `blocking-diagnostic` vs `inventory-only` emission, registry enforcement) is correct. The `claudeAdvisory` model is already `mode: read-only` (rules.yaml:27); this learning confirms that constraint must never be relaxed to blocking.
- Gap columns in solve-buckets.yaml — when selecting proof mechanisms for the `diff-relative`, `dependency-graph`, and `dataflow-taint` buckets, the mechanism must be deterministic (GumTree/RefactoringMiner for diff, CodeQL/Joern for taint). LLM triage is acceptable only as a post-filter on top of a deterministic engine, never as the primary gate.

---

**11. Type-driven prevention is gated on consumer adoption and should not be over-invested**

Making owner forks untypeable (branded/nominal owner types) is the most elegant posture but requires target repos to adopt nominal types — something antidrift cannot force from the lint side. The project's own history is the evidence: `no-cast-to-branded` was retired for "no real adoption or non-test forgery evidence" (gap-inventory.md:171). The brand-kit utility exists but sits unused.

Basis: `docs/whitepaper-agent-code-drift-proofs.md` §2.5 (type-driven prevention, "gated on consumer adoption"); `docs/solve-bucket-architecture-review.md` §3 bucket (4) ("your own history is a caution: no-cast-to-branded was retired for no real adoption"); `policy/registries/solve-buckets.yaml` categories.type-prevention ("GATED ON CONSUMER ADOPTION").

Applies to:
- `antidrift/no-structural-type-fork`, `antidrift/no-canonical-model-fork` — detection is correctly placed in `semantic-ast` and working. Do not invest in a corresponding prevention tier (making forks un-typeable) until real consumer adoption of nominal owner types is demonstrated.
- Gap `unearned-type-authority` (solve-buckets.yaml) — the `type-prevention` bucket is `not-yet-available` but should remain opt-in, not a build target, until adoption evidence exists.

---

**12. The semantic-AST surface is saturating; the highest value move is a change-relative proof spine**

The lint surface has nearly saturated its proof model: the architecture review finds 6 stable rules, 11 stuck at `under-proven` (many with zero blocking findings across thousands of files), and inventories that keep finding zero new blocking drift. The cheapest and highest-value move is diff-scoped existing adapters: run existing semantic proofs against patch hunks as a proof filter (diff-scoped, not a line-count heuristic). This requires no new rules, reuses every existing adapter, and addresses diff-scope-creep (n=60) — the largest measured category.

Basis: `docs/solve-bucket-architecture-review.md` §5 ("Biggest Architectural Gap") and §3 bucket ranking (Rank 1: Diff/change-relative, largest measured category, partial plumbing exists in `git.mjs`/`changedFiles()`); `docs/whitepaper-agent-code-drift-proofs.md` §2.1 (cheapest first step: run existing adapters diff-scoped as a proof filter) and §3 (market gap: no production-grade refactoring-aware diff for TypeScript).

Applies to:
- No existing rule is changed — this is a structural gap at the proof-spine level, not a rule-level fix.
- Gap `diff-scope-creep` (solve-buckets.yaml, n=60, needs: diff-relative) — the `diff-relative` bucket is `not-yet-available`; the seam already exists (`git.mjs`, `changedFiles()` at `cli.mjs:177,218`). The cheapest prototype: scope existing adapter findings to patch hunks, emit into the same `semanticFact` sink.
- Gap `net-new-bias` (n=25, needs: dependency-graph) — partial overlap with diff-relative; adding a new owner via a commit is a change-relative property.

---

**13. The fact/registry spine is the correct backbone to extend; proof-spine additions should emit the same frozen semanticFact shape**

The adapter→rule→frozen-fact→enforcing-registry composition is well-designed: `SEMANTIC_FACT_KINDS` declares emission and `noSinkBehavior`; `check-registries.mjs` fails closed on drift; the `proofBuckets` vocabulary in `policy/index.mjs` already anticipates non-AST buckets. Any new proof spine (diff-relative, dependency-graph, dataflow-taint) should emit into the same `semanticFact` sink at `semantic-facts.mjs:189` rather than building a parallel fact layer.

Basis: `docs/solve-bucket-architecture-review.md` §1 ("The fact contract is the architectural keystone") and §5 mitigating good news ("A diff/graph proof surface can emit the same frozen semanticFact shape, be governed by the same registry spine, and reuse the existing adapters as diff-scoped subroutines"); `docs/whitepaper-agent-code-drift-proofs.md` §3 ("the antidrift system already owns the two hardest non-technique assets: a bucket-agnostic fact/registry spine that can host non-AST proofs, and a real-corpus evidence + maturity discipline").

Applies to:
- All future rules and proof spines — when adding a `diff-relative` or `dependency-graph` proof, thread a "change context" object through a new adapter that emits `semanticFact`s into `semanticFactSink` (semantic-facts.mjs:253). The `factKind` registry, `emission` field, and `check-registries` cross-validation must govern the new surface as they govern the existing AST surface.
- `antidrift/no-sql-string-concat` refactor target — the architecture review flags the 800-line god function as a refactor target independent of the taint-delegation direction; the pattern is: move to its own adapter module like every other proof surface.

---

**14. Evidence discipline requires a real multi-repo baseline; single-repo or single-fixture evidence does not qualify for stable promotion**

The project's promotion requirements (`rules.yaml` promotionRequirements.stable) require `minIndependentRepositories: 2` and `requireReplicationsNotIntroducedForTest: true`. The lifecycle and shard investigations show why: both rules were designed on single-repo (or zero-repo) evidence, and the shard rule's enforcement tier was removed after a second repo confirmed zero hits. A rule that fires only in the repo where its fixtures were written is not measuring real drift.

Basis: `docs/rule-investigations/no-handrolled-resource-lifecycle-proof-rewrite.md` §4 ("Whether to enable the rule as blocking is a separate promotion decision requiring the must-catch/must-ignore set to hold cleanly across ≥2 repos"); `policy/registries/rules.yaml` promotionRequirements.stable block; `docs/rule-investigations/no-shattered-ingested-entity-state.md` §Validation Plan (multi-repo requirement).

Applies to:
- `antidrift/no-handrolled-resource-lifecycle-cells` — the proof rewrite (Learnings 1–3) is done but not sufficient for `error` severity. Promotion additionally requires the must-catch/must-ignore set to hold across ≥2 independent repos. The next slice is corpus validation, not another rewrite.
- `antidrift/no-shattered-ingested-entity-state` — re-promotion needs real owned-entity shatters across more than one repo. The current corpus (two repos, zero positives) is the evidence floor, not just a gap to paper over with agent-generated synthetic fixtures.
- All `under-proven` rules — `minIndependentRepositories: 2` is a hard gate; no `under-proven` rule should move to `error` on evidence from a single codebase.
