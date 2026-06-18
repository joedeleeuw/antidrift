# Ruleset build-out — work-plan, parallel/serial lines, validation criteria, ultracode scoping

Reconciled from two independent xhigh passes (Claude opus-4.8 + codex gpt-5.5), grounded against the
repo. Both passes converged on every structural judgment below; divergences are flagged in §5.
Scope = the rulesets discussed + compared vs `drift`: the 4 under-proven shipped rules, the
change-contract spine, the four gaps (owner-discovery, silent-fallback, duplication/one-owner-fork,
feature-scatter), and the novel change-impact-witnesses. The 16 `ready` rules are the proven baseline,
out of scope here.

**Current status:** change-contract is no longer merely specced. The v0 inventory spine is built:
merge-base change context, schema validation, command-owned semantic fact, TS export diff,
diff-scoped adapter inventory, module graph radius inventory, CLI wiring, verify-session wiring, and
package consumer verification. It is still **not** enforcement-ready. The gating constraint remains
real evidence: the MVP gold TP/TN corpus is now replayable through
`pnpm policy:validate-change-contract-evidence`; the next move is a targeted FP-characterization mine,
not adding `--mode enforce`.

## 1. Planning-maturity audit

Ladder: **codified-proven · codified-under-proven · codified-inventory · specced-not-built · approach-discussed-not-specced · inventoried-only**

| Behavior                                    | Maturity                                  | Single biggest unknown (kills it if false)                                                                   |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `no-handrolled-resource-lifecycle-cells`    | codified-under-proven (0/102)             | reshaped proof catches ≥1 _real_ drift, not normal React style → else retire                                 |
| `no-shattered-ingested-entity-state`        | codified-inventory-only (0/335)           | do real owned-entity shatters exist _at all_ (even in agent code) → else retire                              |
| `no-defensive-shape-probing`                | codified-under-proven                     | 2nd repo has a broad-value mini-parser not already explained by upstream unsafe rules                        |
| `no-underchecked-type-predicate`            | codified-under-proven                     | real required-field predicate drift exists (current broad inventory: 0 findings)                             |
| **change-contract** (diff-scope-creep n=60) | **codified-inventory**                    | replayed contracts stay clean on TNs and a second targeted mine characterizes FP pressure before enforcement |
| **owner-discovery / net-new-bias** (n=25)   | approach-discussed-not-specced            | deterministic owner-equivalence stays clean on DTOs/facades/boundary models                                  |
| **duplication / one-owner-fork** (n=31+28)  | codified-inventory · _fastest stable win_ | declaration-clone source-fleet inventory proves actionable owner forks beyond existing declared-owner rules  |
| **silent-fallback** (n=24)                  | approach-discussed-not-specced            | delegated dataflow proves caught-error→sink reachability w/ project sink registries (do NOT hand-roll IFDS)  |
| **change-impact-witnesses**                 | approach-discussed-not-specced (novel)    | unwitnessed changed surfaces correlate with actionable defects (does not prove intent)                       |
| **feature-scatter** (n=13)                  | inventoried / spec-only                   | a configured repo architecture model exists at all (current rule = review guidance)                          |

## 2. Parallel-vs-serial dependency DAG

**Irreducible serial barriers:**

1. **Evidence go/no-go before any build.** The shard + lifecycle rules shipped on synthetic evidence
   and caught nothing — the project's most expensive lesson. Every new spine's build is gated on a
   real-corpus probe. _Mine+adjudicate fans out; the go/no-go decision is the gate._
2. **Registry-ripple gate-loop** — semantic facts, registry YAML, registry checks, public types, and
   consumer package verification. The change-contract command-owned fact has been converged through
   this loop; any new fact kind, carrier, proof bucket, or public package surface still converges
   serially.
3. **Final gate** `pnpm policy:verify-session` (generated, registry, rule-surface, corpus, external
   corpus, package, lint, typecheck, tests — `verify-session.mjs:6`).
4. **≥2-repo promotion** (terminal; `rules.yaml:12` minIndependentRepositories: 2).

**Two shared substrates → sequence, don't parallelize, the spines that sit on them:**

- **`change-context`** (merge-base diff surface) feeds **four** consumers: change-contract,
  diff-scoped adapters, owner-on-write, change-impact-witnesses. Building it first unlocks all four.
- **structural/type index** (TS Program owner fingerprints) feeds **two**: declaration-clones and
  owner-discovery. Build once, then branch.

**Independent lines (safe to run concurrently):** per-behavior corpus mining (fully disjoint) · the 4
under-proven re-validations (re-run existing engines, no new substrate) · post-go/no-go pure-core
module builds (worktree-isolated) until the registry barrier.

```
[mine + adjudicate per behavior]  ──serial go/no-go──▶
   ┌─ change-context substrate ─▶ change-contract (or pivot) · diff-scoped adapters · impact-witnesses
   ├─ structural/type index ────▶ declaration-clone · owner-discovery
   └─ silent-fallback (intra-proc; inter-proc delegated to CodeQL/Semgrep)
        … all converge ▶ SERIAL registry-ripple ▶ verify-session ▶ ≥2-repo promotion
```

## 3. Exact validation criteria (definition-of-done), grounded in real commands

Two bars. **(a) plumbing-proven** = mechanism runs + emits the promised artifact. **(b) value-proven**
= real TPs **and** clean real TNs across **≥2 repos** (fixtures are regression-only, never evidence).
The **≥2-repo bar has existing machinery**: the inventory commands take `--repo <comma-list>` and a
24-repo fleet is already wired (`policy:inventory-sql-source-fleet`). New spines plug into that.

| Rule/spine                                          | (a) Plumbing-proven                                                                                                                                                                                                                                                                                                                                                                                                                        | (b) Value-proven                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **lifecycle-cells**                                 | `pnpm policy:inventory-react-state` → `reports/react-state-inventory.json`; `verify-session` green; consumer package still passes if fact payload changes                                                                                                                                                                                                                                                                                  | catches Chaski weekly-digest + the 102-shape corpus, ignores stale-while-revalidate / pagination / UI-cleanup / abort-guarded / owned-hook controls; replicate in ≥1 second repo. Still 0 real TPs → **retire**                                                                                                       |
| **shard-state**                                     | inventory emits `sourceMemberStateShardCandidate`, never diagnostics; `verify-session` green                                                                                                                                                                                                                                                                                                                                               | several real owned-entity shatters across >1 repo + clean edit-form / pagination / SWR-query / envelope / view-state controls. Absent even in agent code → **retire**                                                                                                                                                 |
| **defensive-shape-probing**                         | `pnpm policy:inventory-defensive-shape` → `reports/defensive-shape-inventory.json`, 0 parser errors                                                                                                                                                                                                                                                                                                                                        | 2nd real drift repo (preferably `unknown`-typed), not same-file upstream-unsafe overlap, no FPs in broad inventory                                                                                                                                                                                                    |
| **underchecked-predicate**                          | `pnpm policy:inventory-underchecked-predicate` parser-clean                                                                                                                                                                                                                                                                                                                                                                                | real broad-input `x is T` / `asserts x is T` missing required asserted fields in another repo + validator/discriminant clean controls                                                                                                                                                                                 |
| **change-contract**                                 | temp-git-repo merge-base tests; CLI `antidrift change-contract`; `policy:inventory-change-contract`; `policy:validate-change-contract-evidence`; command-owned `changeContractConformance`; TS export diff; diff-scoped adapters; module graph radius inventory; `check-registries`; `package:verify`; `verify-session`. Missing contract → exit 0; invalid/missing-base/invalid graph config → fail when a contract asks for that surface | **MVP:** 5 unambiguous TPs across 2 repos + 7 clean TN controls replay through the built spine. **Promotion:** ≥6 real cases across ≥2 repos, no known FP/FN, and a targeted refactor/test/ci/build clean-control mine. **Else pivot:** forward pre-authored-contract gate enforces with zero FP on N real future PRs |
| **owner / clone / silent-fallback / impact spines** | new inventory command emits through the same semantic-fact sink (`semantic-facts.mjs:189`) or writes a replayable inventory artifact governed by the registry                                                                                                                                                                                                                                                                              | deterministic TPs + clean controls across ≥2 repos. **If behavior is LLM-judgment-bound → done-state is inventory-only, never blocking**                                                                                                                                                                              |
| **feature-scatter**                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                          | done-of-next-step is a discussion doc identifying the deterministic core + boundary (parity with the other gaps), not an engine                                                                                                                                                                                       |

**Real change-contract TN suite (free validation evidence, from the MVP mine):** `sudocode-main@52dec81e`
(README-only), `sudocode-main@d0ea172b` (declared js-yaml dep; `.sudocode/issues.jsonl` = auxiliary,
not creep), `chaski@b5e18da03` (declared eslint --fix/prettier ×78), `chaski@d6c56c0d5` (declared proto
comments + generated bindings — critical generated-surface control), `chaski@59e1bee78`,
`chaski@9da69cc59`, `sudocode-main@0402e9eb`. **TP candidate (needs body adjudication):** `chaski@32c924c53`.

## 4. Ultracode scoping

### Workflow 1 — `change_contract_mvp_evidence_gauntlet` (highest-leverage first run)

Resolves the n=60 kill-condition _and_ seeds real corpora for the other behaviors. This _is_ the
adversarial-verify pattern the MVP proved necessary (FP-kill is the whole game).

1. `phase("metadata-only contract mining")` — 12–16 agents over disjoint Chaski/Sudocode/AIDev slices,
   multi-modal (each keys a different high-confidence intent pattern, blind to others). Read intent
   text first and **freeze a small contract before diff review.**
2. `phase("diff conformance extraction")` — deterministic compare of frozen contract vs changed
   paths/deps/exports/generated surfaces.
3. `phase("adversarial verify")` — 3 skeptics/candidate, each prompted to **refute** by reading the
   full PR body / linked ticket; majority-refute or ambiguity demotes/kills.
4. `phase("TN pressure")` — dedicated agents validate the supplied TN suite + broad-change controls.
5. `phase("completeness critic")` — 2–3 agents ask what mining modality / clean control is missing.
6. **Serial synthesis** — go / pivot / mine-more.

Read-only; **no worktree**; not loop-until-dry (fixed ~100-commit mine). ~12 finders + candidates×3
verify + TN/critic ≈ ~130 agents (within cap). Structured outputs:

```
ContractCandidate    = { candidateId, repo, commit, intentText,
                         frozenContract:{ allowedPaths[], forbiddenPaths[], allowedChangeTypes[],
                           allowedRuntimeDependencies[], allowedDevDependencies[], allowedExports[],
                           rejectIfVague },
                         actualSurface:{ paths[], changeTypes[], dependencies[], exports[], generatedSurfaces[] },
                         proposedLabel: tp|tn|ambiguous|reject, evidenceRefs[], ambiguityFlags[] }
AdversarialVerification = { candidateId, verdict: confirm|refute|ambiguous,
                            authorizingText|null, falsePositiveClass|null, reason }
WorkflowVerdict      = { decision: build_historical_spine|pivot_future_contract_gate|mine_more,
                         truePositiveCount, trueNegativeCount, reposRepresented[],
                         killedCandidates[], remainingUnknowns[] }
```

### Workflow 2 — `under_proven_rule_evidence_refresh` (clean parallel, cheap)

Four read-only lanes (one per under-proven rule), 4–6 agents each, adversarial-verify only for claimed
TPs, no worktree. Return `{ ruleId, repo, path, candidateKind, commandToReproduce, expectedFinding,
cleanControl, promotionImpact, refutationRisk }`. Each lane ends in promote / reshape / retire.

### Build workflow (only after a GO)

Worktree isolation for mutating parallel slices (contract-schema, change-context, dependency surface,
export diff, JSON fact output); registry reconciliation stays **inline/serial**. Builder schema:
`{ slice, filesTouched, publicSurfaceChanged, commandsRun, artifacts, registryRippleNeeded, unresolvedRisks }`.

### Wrong tool for a workflow (do inline/serial)

Human contract acceptance · registry-ripple convergence · `verify-session` · stable promotion ·
LLM-bound semantic adjudication at proof time. Ultracode is for mining, adversarial verification,
completeness criticism, and independent build slices — not the global gate loop.

## 5. Open decisions (for the human)

1. **change-contract enforcement readiness** — GO for inventory is resolved; NO for blocking until a
   second targeted mine characterizes refactor/test/ci false-positive pressure.
2. **declaration-clone promotion** — inventory exists and source-fleet evidence is recorded. The open
   decision is not whether to build the spine, but whether any clone group proves an accepted owner
   fork strongly enough to become a blocking rule rather than research inventory.
3. **silent-fallback intra- vs inter-procedural split** — needs a catch-block corpus pass to decide how
   much is reachable intra-procedurally (deterministic, ours) vs delegated to CodeQL/Semgrep.
