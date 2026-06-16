# Architecture Review: `@joedeleeuw/antidrift` Anti-Drift Guardrails

A senior architecture review of the two-layer lint system, its proof mechanisms, and the solve-bucket strategy against the measured behavior distribution. Read-only; all claims cite `file:line`.

## TL;DR / Verdict

The lint half of this system is **genuinely well-architected** — the adapter/rule/fact/registry composition is one of the cleaner semantic-lint designs I've reviewed, and the team has been unusually honest about retiring rules that don't earn their keep. But the architecture is built to answer a question the data says is **not the dominant one**. Your own exhaustive sweep (`reports/complaint-sweep-2026-06-10.json`) puts diff-scope-creep at n=60 and the whole agent-behavior cluster at ~225 of 545 keepers, and **the per-file/intra-procedural/snapshot proof model is structurally incapable of touching any of it** (verified: zero `git`/`getSourceFiles`/cross-file reads in the rule layer; the only whole-program reach is read-only TypeChecker enumeration in `type-index.mjs:106,192,312`).

So: **the lint architecture is the right foundation to *keep*, but the *system* needs a structural addition** — a second proof spine that operates on the **change**, not the snapshot. This is not a hook/heuristic; it's a real, research-backed analysis surface (AST-diff + reflexion-model conformance) that the current four buckets do not contain. Detail below.

---

## 1. Code Composition & Architecture

**The four-stage spine is sound and the seams are real.** The flow is: adapters (`semantic-adapters/*.mjs`) expose pure proof functions → rules (`eslint-plugin/index.js`) call them and decide report-vs-emit → facts (`policy/lib/semantic-facts.mjs`) are frozen, hashed, schema-versioned records → the registry spine (`check-registries.mjs`) forces all surfaces to agree.

What's genuinely good:

- **The fact contract is the architectural keystone.** `SEMANTIC_FACT_KINDS` (`semantic-facts.mjs:6-85`) declares each kind's `emission` (`blocking-diagnostic` vs `inventory-only` vs `inventory-proposal`) and `noSinkBehavior`. The blocking decision is *not* ad-hoc: the lifecycle rule reports only when `proof.proven && !frame.requestGuard` (`index.js:753`), and structural-fork rules report only inside `if (proof.diagnostic.emitted)` gated on `authorityState === "accepted"` (`index.js:2627-2635, 2812`). This cleanly separates "I noticed a suspect" from "I can prove a violation" — exactly the discipline the roadmap preaches (`rule-roadmap.md:15-21`).
- **The registry spine actually enforces agreement**, not just documents it. `check-registries.mjs` cross-validates proofBuckets between the adapter manifest and stable rule promotion entries (`checkSemanticAdapterStableRuleProofBuckets:1460`), fact-kind/adapter membership (`1602-1717`), and shipped-vs-declared fact contracts (`1227,1351`). This is the thing that keeps a 4-surface design from rotting. Most "registry" layers I review are aspirational; this one fails closed.
- **The behavior-classification adapter is the best idea in the repo.** `react-state-graph.js` classifies setter writes by *value behavior* (`trueConst`/`caughtError`/`awaited`, `classifyWriteValue:31-54`) and never by identifier name — the comment at `:5-9` and the retirement of `no-status-triplet-state` (`rule-roadmap.md:323-328`) show the team learned that names are gameable and shapes are not. `lifecycleProof` (`:339-363`) demands the *full* hand-rolled machine (bool toggle + error reset + awaited payload) before blocking. This is principled.

Where it does **not** scale / over-engineers:

- **`ruleNoSqlStringConcat` is a ~800-line god-function** (`index.js:1692-2488`) with ~30 nested closures and a near-complete duplicate escaper detector implemented twice — once over ESTree (`sqlEscaperFunctionKind:1183`) and once over `ts.*` (`tsSqlEscaperDeclarationKind:1296`), plus four variants of the same `.map().join()` walk (`1379,1441,1866,1892`). One rule dominates a 3,262-line file. This is the clearest local refactor target; it should be its own adapter module like every other proof surface.
- **`no-structural-type-fork` and `no-canonical-model-fork` share a near-identical `check` body** (`index.js:2706-2826` vs `2828-2920`) differing only in candidate source and the resolves-to-own guard. The `requireTypeServices → missingTypeServicesVisitors → getTypeChecker()` triad is inlined in ~8 rules instead of being a single HOF.
- **Manifest/fact/registry triplication.** `SEMANTIC_FACT_KINDS` is hand-mirrored in `rules.yaml:30+` and validated by the spine. That's defensible (the spine catches drift), but it's three hand-maintained copies of the same truth. A single generator would remove a class of busywork the team is clearly already spending time on.

**Missing seam (the important one):** every proof surface assumes a single `SourceCode`/`Program` snapshot. There is no "change context" object threaded anywhere — no baseline ref, no before/after AST, no per-PR fact aggregation. The fact sink (`semanticFactSink:253`) is the one place that *could* become a cross-invocation aggregation point, but today it's per-file emit-only. That's the seam a diff/graph layer would need, and it doesn't exist yet.

---

## 2. Proofing Mechanisms — What They Structurally Cannot Prove

The proofs (AST + scope + control-flow + TypeChecker) are sound **within their box**. The box has three hard walls, and I verified each in code:

**Wall 1 — Per-file.** No rule reads another file, runs git, or iterates source files. The only whole-program access is `type-index.mjs` enumerating exported types through the shared TypeChecker `Program` (`collectCanonicalTypes:130`, `program.getSourceFiles():106`), memoized via `canonicalCache = new WeakMap()` keyed on program (`index.js:2669`). Crucially this is **read-only type enumeration invoked per-file** — it can answer "does *this file's* local type match an owner shape?" but never "did *this change* add a second owner?" or "is this the only definition in the repo?"

**Wall 2 — Intra-procedural.** The adapters reason inside one function frame. `react-state-graph.js` builds a per-function `frame` and resolves bindings only up the lexical `functionStack` (`cellFor:172-178`); `broad-input.mjs` walks a single function's AST/scope (`walkNode:112`). There is no call graph, no value tracking across function boundaries, no taint propagation from a source param to a distant sink.

**Wall 3 — Snapshot-in-time.** Every rule sees the current file state. There is no notion of "what this commit changed." `git.mjs` and `changedFiles()` exist but are used **only** by the agent-ops `check-changed`/`verify-session` scripts (`cli.mjs:177,218`), never by a proof.

**Classes of behavior these walls make structurally unprovable:**

| Behavior class | Why it's outside the box | Evidence in your data |
|---|---|---|
| **Diff-scope-creep** | It's a property of the *change* (added lines / touched packages vs task), not any file snapshot. No snapshot proof can express it. | n=60, the single largest category (`complaint-sweep:268-272`) |
| **Net-new-bias / "owner already exists"** | Requires a *repo-wide uniqueness* query ("is there another owner?") and ideally before/after ("you added a 2nd owner"). Per-file type matching (`no-canonical-model-fork`) only fires when an owner is *already declared in the registry* — it cannot discover that the agent just created a duplicate. | n=25 (`:273-276`); "feature-scatter" n=13 (`:64-68`) |
| **Silent fallback where the caught error flows nowhere** | `errors/no-fallback-to-empty` is the #1 unimplemented policy gap (`gap-inventory.md:95`). Proving "the catch returns `[]` and the error reaches no sink" is an *inter-procedural dataflow/taint* question once the catch delegates to a helper. | n=24 + 3 (`:14-18`) |
| **Injection / value-reaches-sink** | `no-sql-string-concat` already strains intra-procedural limits (the 800-line function exists *because* it's manually re-implementing escaper-reachability that taint analysis gives for free; `no-unsafe-deserialize` notes its own parser-services dependency). True provenance ("this request param reaches this query unescaped across 2 helpers") needs IFDS-style flow. | sql n=3, parse-at-edge n=5 |
| **Cross-layer imports / cycles / fan-in** | Project-graph questions, correctly delegated to `boundaries`/`import-x` today, but feature-scatter and high-fan-in growth (`policy-coverage.md:21`) need a real architecture model, not import-pair rules. | feature-scatter n=13 |

The honest summary: **the proofs are excellent at "this construction, in this function, is illegal." They are blind to "this change introduced drift relative to the repo or the baseline."** And that second sentence is where your measured volume lives.

---

## 3. Solve Buckets — Validate / Refute / Rank

**Is semantic-AST the right *primary* bucket?** For the *lintable* ~40% of keepers, yes — and the team has nearly saturated it. The four current buckets (`local-ast-source-shape`, `semantic-source-type-provenance`, `authority-index-ownership`, `graph-config-source`) are a correct decomposition of *snapshot* proof. But they are all snapshot buckets. Calling semantic-AST "primary" is correct only if you scope the mission to syntax-shaped drift. Against the *full* behavior distribution, semantic-AST is primary for the minority and **absent for the plurality**.

**The four candidate missing buckets — assessment:**

**(1) Diff / change-relative analysis — VALIDATE, top priority.** This is the missing bucket that maps to your #1 measured behavior. AST-diff vs `git merge-base`, tree-diff (GumTree/ChangeDistiller), and refactoring detection (à la RefactoringMiner) are real, research-backed, deterministic mechanisms — *not* heuristics. They directly express "added a new X," "200-line diff for a 1-line task," "moved logic into a new service." Maps to: diff-scope-creep (60), net-new-bias (25), unnecessary-service-layer, scope-drift. This is the highest value-to-effort move because the plumbing partly exists (`git.mjs`, `changedFiles`) and the fact sink can become the aggregation point.

**(2) Inter-procedural dataflow / taint (IFDS/IDE, CodeQL-style) — VALIDATE, high value / high effort.** This is the *correct* mechanism for silent-fallback (caught error flows nowhere, n=24), injection/secrets, and value-reaches-sink. It would also *retroactively simplify* `no-sql-string-concat`: that 800-line function is a hand-rolled, single-file approximation of reachability that a real flow engine does generally. Refute the framing only on effort: a from-scratch IFDS engine is large; the pragmatic path is delegating to CodeQL/Semgrep-pro for the flow queries and keeping antidrift as the policy/fact layer.

**(3) Project dependency-graph / architecture conformance (reflexion models, fitness functions) — VALIDATE, and it's under-credited.** You currently delegate cross-layer/cycles to `boundaries`/`import-x` (correctly), but feature-scatter (n=13) and **repo-level owner uniqueness** (the real fix for net-new-bias) need a *whole-repo model*, not import-pair rules. A reflexion model (declared architecture vs extracted graph) is the canonical research approach. This bucket is also the natural home for "is there already an owner for this concept?" — which is the question `authority-index-ownership` *wants* to answer but can't, because it only knows registry-declared owners, not discovered ones.

**(4) Type-driven prevention (make-illegal-states-unrepresentable, branded/nominal owners) — EXTEND, do not over-invest.** Conceptually the most elegant — it converts "detect a fork after the fact" into "the fork won't typecheck." But your own history is a caution: `no-cast-to-branded` was **retired** for "no real adoption or non-test forgery evidence" (`gap-inventory.md:171`), and the brand kit sits as a utility (`policy-coverage.md:19`). Prevention requires the *target repos* to adopt nominal owner types — that's a consumer-adoption problem antidrift can't force from the lint side. Keep it as an opt-in capability, not a bucket you build infrastructure around.

**Ranking missing buckets by value-to-effort against the measured distribution:**

| Rank | Bucket | Target behaviors (measured n) | Effort | Why this rank |
|---|---|---|---|---|
| **1** | **Diff/change-relative** | diff-scope-creep (60), net-new-bias (25), scope-drift (5) | Med | Largest measured category; partial plumbing exists; deterministic; the one wall (snapshot) it breaks is the load-bearing one |
| **2** | **Project graph / reflexion** | feature-scatter (13), net-new owner uniqueness, cross-layer | Med-High | Enables the *real* net-new-bias fix (owner discovery, not just registry lookup); complements diff bucket |
| **3** | **Inter-procedural taint** | error-fallback (24), injection (sql 3 + deserialize), value-reaches-sink | High | Highest correctness payoff but heaviest build; best delegated to CodeQL/Semgrep rather than hand-rolled |
| **4** | **Type-driven prevention** | type forks, domain literals | Med (but gated on consumer adoption) | Elegant, but blocked by adoption reality your own retirements already proved |

---

## 4. Research-Backed Approaches Missing *Entirely* (beyond the four)

- **AST-diff / refactoring detection as a first-class engine** (GumTree, ChangeDistiller, RefactoringMiner). Distinct from "diff bucket" generically: these classify *what kind* of change happened (extract-method, move, rename, add-type). That's exactly the granularity needed to say "you added a new owner" vs "you edited the existing one." Fits net-new-bias and "unnecessary-service-layer."
- **Software Bertillonage / clone & near-duplicate detection across the repo** (Type-2/Type-3 clones, not just Sonar CPD within-file). Your top *validated* family is duplication (n=31, `complaint-sweep:5-8`) and one-owner-fork (n=28). Cross-file structural clone detection is the research-grounded mechanism; today it's delegated to Sonar CPD which the docs note misses semantic forks.
- **Code-property-graph (CPG) analysis** (Joern). A CPG unifies AST + CFG + PDG + call graph + types into one queryable graph — it would subsume buckets 2 and 3 *and* much of the existing semantic-AST work under one substrate. If you ever consolidate, this is the substrate to consolidate onto. Fits injection, fallback, fan-in, ownership-reachability.
- **Architectural fitness functions / conformance over commit history** (evolutionary architecture). Beyond a single reflexion snapshot: track whether a *change* increases coupling, scatters a feature, or grows a hotspot — git-history-aware, deterministic, and the literal definition of high-touch file growth (`rule-roadmap.md:96`). Fits feature-scatter and "high-touch file growth."
- **Differential / changed-lines-scoped analysis (à la reviewdog, but as a *proof filter* not a comment bot)**: run the existing semantic proofs but score/gate them relative to the patch hunks. This is the cheapest bridge — it reuses every existing adapter and just adds change-relativity on top. (This is *not* the agent-ops hook you've barred; it's running real proofs against a diff baseline.)

---

## 5. The Single Biggest Architectural Gap / Risk

**The system's proof spine and the system's measured value have almost no overlap, and the architecture has no seam to close that gap.**

Concretely: ~225 of 545 keeper complaints are agent-behavior (`rule-mining-protocol.md:232`), led by diff-scope-creep (60) and net-new-bias (25). **Every one of these is a property of the change or the repo graph, and the entire proof layer is per-file/intra-procedural/snapshot** (Walls 1–3, verified). The team *correctly diagnosed* this — the roadmap routes these to a `diff+task+graph` agent-ops bucket (`rule-roadmap.md:55,80-101`) — but then constrained that bucket to hooks/policy-scripts/PR-bots, i.e. **the heuristic fallback the maintainer explicitly wants to move past.** So today the highest-value behaviors are served either by nothing or by exactly the mechanism class you've ruled out.

The risk this creates: the lint surface is mature and *saturating* (6 stable, 11 stuck "needs real-corpus promotion," several default-off with 0 blocking findings across thousands of files — `gap-inventory.md:114,123`). Continued investment in semantic-AST has **sharply diminishing returns** (the inventories keep finding zero new blocking drift), while the 60+25+24 categories sit structurally unaddressed. The architecture isn't wrong; it's *complete* for its scope and the scope is the minority of the problem.

The mitigating good news: the fact/registry spine is the right backbone to extend. A diff/graph proof surface can emit the *same* frozen `semanticFact` shape (`semantic-facts.mjs:189`), be governed by the *same* registry spine, and reuse the existing adapters as diff-scoped subroutines. You don't need to rebuild; you need to add a spine that the current one was clearly designed to accommodate (the bucket vocabulary in `index.mjs:42-45` already anticipates non-AST buckets).

---

## Prioritized Recommendation (top 3 moves)

1. **Build a change-relative proof surface as a real bucket (not a hook).** Thread a "change context" (baseline `merge-base` AST + patch hunks) through a new adapter that emits `semanticFact`s into the existing sink. Start by running *existing* adapters diff-scoped (cheapest, reuses everything), then add AST-diff/refactoring classification for "added a new owner / new entry point." This is the deterministic, research-backed answer to diff-scope-creep (60) and net-new-bias (25) — the maintainer's #1 and #2 — and it explicitly is *not* a line-count heuristic.

2. **Promote owner *discovery* to a repo-graph proof.** `authority-index-ownership` today only enforces *registry-declared* owners (`type-index.mjs:140-210`), so it cannot catch the agent minting a duplicate. Add a whole-repo reflexion/uniqueness pass (or delegate to a CPG/Semgrep query) that proves "a second owner for concept X now exists." This closes net-new-bias and feature-scatter (13) at the structural level instead of the registry level.

3. **Delegate inter-procedural flow to CodeQL/Semgrep-pro rather than hand-rolling it — and refund the savings.** Use it for fallback-to-empty (24), injection, and value-reaches-sink, and use it to *replace* the 800-line single-file SQL escaper-reachability function (`index.js:1692-2488`) with a real taint query. Keep antidrift as the policy/fact/registry layer over those engines.

## Verdict

**Extend the foundation; add one structural spine.** The lint architecture — adapters → rules → frozen facts → enforcing registry — is well-composed, honestly maintained, and correct for snapshot-shaped drift; do not rewrite it. But it is *architecturally incapable* of serving the plurality of measured complaints, and patching that with hooks/heuristics is the path the maintainer rightly rejects. The right move is a **second, peer proof spine — change-relative + repo-graph — that emits into the same fact/registry backbone.** The existing system was, perhaps inadvertently, designed to accept exactly this addition (generic `proofBuckets`, a fact sink that can aggregate, a registry that enforces cross-surface agreement). That is a structural change in *capability*, achieved by *extension* rather than replacement.
