# Proving the Drift We Can't Yet Prove
### Research-backed strategies for governing agent-authored code, and the market gap they leave open

Status: working whitepaper / market research. Companion to `policy/registries/solve-buckets.yaml`
(the per-rule triage) and `docs/solve-bucket-architecture-review.md` (the architecture review).

---

## 0. Thesis

A guardrails system for agent-authored TypeScript (`@joedeleeuw/antidrift`) measured its own demand:
of ~545 keeper complaints mined from real agent sessions, ~225 are *agent-behavior* drift rather
than lintable syntax, led by **diff-scope-creep (n=60)**, **duplication (n=31)** and
**one-owner-fork (n=28)**, **net-new-bias (n=25)**, and **silent-fallback (n=24)**. The system's
proof engine is ESLint + the TypeScript type-checker — a *per-file, intra-procedural, snapshot*
mechanism. Every one of those top behaviors is a property of **the change**, **the repository
graph**, or **inter-procedural flow** — none of which a file snapshot can express. The behaviors we
*cannot* prove are not missing rules; they are missing **proof mechanisms**.

This document does the market/literature research on the research-backed mechanism for each, and
argues the genuine gap: the methods are mature in isolation (and mostly Java/security-oriented), but
nothing unifies them as *provable, evidence-gated proofs targeted at agent-authored-code drift in
TypeScript* under one governance contract. That unification — not any single technique — is the
open space.

The market itself now agrees on the premise. The 2025→2026 framing across vendors is an explicit
shift "from speed to governance," with the observation that **"AI increases the size of diffs but
human review doesn't scale linearly… AI-authored code is more cognitively demanding to review"** and
that **"traditional static analysis doesn't catch most of these risks because the threat is in the
workflow, not just the code"** ([tfir.io](https://tfir.io/ai-code-quality-2026-guardrails/),
[TrueFoundry](https://www.truefoundry.com/blog/best-ai-code-security)). Veracode's 2025 research
found AI introduced vulnerabilities in 45% of coding tasks tested
([Checkmarx](https://checkmarx.com/learn/ai-security/top-12-ai-developer-tools-in-2026-for-security-coding-and-quality/)).
There is even a fresh academic benchmark for exactly this problem — *Needle in the Repo: A Benchmark
for Maintainability in AI-Generated Repository Edits*
([arXiv:2603.27745](https://arxiv.org/pdf/2603.27745)).

**By mid-2026 the behavior distribution we mined internally is corroborated at industry scale.**
Google's 2025 DORA report ties a 90% rise in AI adoption to a **154% increase in PR size** and a 91%
increase in review time; GitClear's 153M-line longitudinal analysis shows **code duplication up 4x**,
an 8x rise in 5+-line duplicate blocks, and **2024 as the first year copy/paste exceeded moved code**
— net-new over reuse, quantified ([Sonar](https://www.sonarsource.com/blog/the-inevitable-rise-of-poor-code-quality-in-ai-accelerated-codebases/),
[Second Talent](https://www.secondtalent.com/resources/ai-generated-code-quality-metrics-and-statistics-for-2026/)).
GitHub's January 2026 study *More Code, Less Reuse* finds agent-generated code adds more redundancy
and technical debt per change and names the review trap exactly: **"the surface looks clean, the debt
is quiet"** — and reviewers *feel better* approving it ([GitHub Blog](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/)).
The MSR 2026 Mining Challenge ships the **AIDev** dataset (24,014 agentic vs 5,081 human merged PRs);
agentic PRs differ substantially in commit count, files touched, and **PR-description-vs-diff
consistency** — a diff-relative signal by construction ([arXiv:2601.17581](https://arxiv.org/html/2601.17581)).
The root cause is stated plainly in the literature: **LLMs optimize local functional correctness over
global architectural coherence.** Diff-scope-creep, duplication, and net-new-bias are no longer our
hunch; they are the measured signature of agent-authored code.

---

## 1. The three structural walls (why lint can't reach the plurality)

The current proof mechanism (semantic-AST) is sound *within a box* bounded by three walls, each
verified in the codebase:

- **Per-file.** No rule reads another file, runs git, or iterates source files; the only whole-program
  reach is read-only type enumeration. It can ask "does *this file's* type match a declared owner?"
  but never "is this the *only* definition in the repo?"
- **Intra-procedural.** Adapters reason inside one function frame. There is no call graph and no
  taint propagation from a source parameter to a distant sink.
- **Snapshot-in-time.** Every rule sees the current file state. There is no notion of "what this
  commit changed."

| Behavior (measured n) | Property it actually is | Wall it hits |
|---|---|---|
| diff-scope-creep (60) | change vs. task baseline | snapshot |
| duplication (31) / one-owner-fork (28) | cross-file structural similarity | per-file |
| net-new-bias (25) / feature-scatter (13) | repo-wide ownership/uniqueness | per-file + snapshot |
| silent-fallback (24) / injection | value-reaches-sink reachability | intra-procedural |

The honest summary: the proofs are excellent at *"this construction, in this function, is illegal,"*
and blind to *"this change introduced drift relative to the repo or the baseline."* The measured
volume lives in the second sentence.

---

## 2. The research-backed proof spines

### 2.1 Change-relative analysis → diff-scope-creep, net-new-owner

**The method.** AST-diff against the merge-base, made *refactoring-aware*. Plain tree-diff
(**GumTree 3.0**, the standard baseline) "blindly" matches the largest similar sub-trees and fails on
the exact case we care about: when a method body is extracted to a new method, GumTree erroneously
matches the original declaration to the *extracted* one. **RefactoringMiner 3** fixes this by using
detected refactorings to guide statement mapping — 60 refactoring types, **99.6% precision / 94%
recall**, and uniquely **inter-file move detection (P/R 99.6%, all competitors 0%)** and
**multi-mapping** for duplicated code (others recall <11%)
([TOSEM 2024](https://dl.acm.org/doi/10.1145/3696002),
[arXiv:2403.05939](https://arxiv.org/pdf/2403.05939),
[RefactoringMiner](https://www.emergentmind.com/topics/refactoringminer)).

**Why it fits.** "You added a new owner / extracted logic into a new service / 200-line diff for a
1-line task" is *literally* refactoring classification + change-scope over a diff. Inter-file move +
multi-mapping is precisely the signal for net-new-owner.

**The gap.** RefactoringMiner is **Java-only**; the frontier is just reaching C++ (RefactoringMiner++,
2025) and Python (PyRef/ActRef) — *no production-grade refactoring-aware diff exists for TypeScript.*
That is a real, buildable gap, and the cheapest first step needs neither: run the *existing* snapshot
proofs **diff-scoped** (score/gate findings relative to the patch hunks) — a proof filter, not a
heuristic, reusing every adapter we already have.

### 2.2 Clone / near-duplicate detection → duplication, one-owner-fork (the top *validated* family)

**The method.** Cross-file structural clone detection. The two reference tools: **NiCad** (text/TXL,
normalization + LCS, the precision "gold standard" for near-miss **Type-3** clones, ~90–96% precision
with up to 100% recall on BigCloneBench) and **SourcererCC** (token + inverted index, scales to
**250 MLOC** cross-project) ([SourcererCC](https://dl.acm.org/doi/pdf/10.1145/2884781.2884877),
[clone tool survey](https://clones.usask.ca/clones/tools/),
[Eclipse IIoT study, 2026](https://arxiv.org/pdf/2603.27308)). Recall↔scale is the classic trade-off;
ML methods (e.g. graph-based [Gitor](https://arxiv.org/pdf/2311.08778)) push toward semantic **Type-4**
clones that token/text tools miss.

**Why it fits.** "The agent re-implemented something that already exists" is duplication; "it forked
an owner's model into a near-copy" is a Type-3 clone of a known owner. This is the system's #1
*validated* complaint family and is delegated today to within-file Sonar CPD, which the docs note
misses semantic forks.

**The gap.** These tools answer "are there clones?" across a corpus; the *agent-governance* question
is narrower and unanswered: **"did *this change* introduce a near-duplicate of a known owner?"** —
clone detection scoped to the diff + the owner registry.

### 2.3 Repo-graph / architecture conformance → net-new-bias, feature-scatter

**The method.** The **Reflexion Model** (Murphy, Notkin & Sullivan) — map an intended architecture to
a model extracted from the code and report mismatches — operationalized as **architectural fitness
functions** in CI: **ArchUnit** (Java), **dependency-cruiser** (TS/JS), **Deptrac** (PHP),
**go-arch-lint** (Go) ([reflexion/ACC survey](https://www.sciencedirect.com/science/article/pii/S0920548923000557),
[fitness functions](https://developersvoice.com/blog/architecture/architectural-fitness-functions-automating-governance/)).
The 2026 frontier is explicit about our use case: *"predicting the architectural impact of a proposed
pull request"* and automated **drift scoring** of the whole model against the repo
([earezki.com, 2026](https://earezki.com/ai-news/2026-06-08-architecture-drift-detection-keep-your-code-aligned-with-design/),
[MAPE-K conformance, arXiv:2401.16382](https://arxiv.org/pdf/2401.16382)).

**Why it fits — the key insight.** Authority-index ownership today only enforces *registry-declared*
owners, so it cannot catch the agent *minting a new duplicate owner*. A whole-repo
reflexion/uniqueness pass ("a second owner for concept X now exists") is the structural fix for
net-new-bias, and the home for feature-scatter and layering.

**2026 precedent.** This bucket is now being built for exactly our problem. *drift* is an open-source,
**deterministic (no LLM)** analyzer that detects AI-generated architectural erosion, pattern
fragmentation, and *mutant duplicates* via cross-file coherence — *"your linter, type checker, and
test suite won't catch this; drift does — deterministically"* ([drift](https://github.com/sauremilk/drift)).
*Archyl* computes a continuous **drift score** of code-vs-architecture and exposes the C4/ADR model to
agents over MCP so they read it before writing ([Archyl](https://www.archyl.com/blog/ai-agents-transforming-architecture-documentation)).
drift validates the deterministic cross-file approach in production — but it is Python-only and does
not do owner discovery against a concept registry.

**The gap.** Existing fitness-function tools enforce *declared dependency rules* (import linting).
They do not do **owner discovery** ("is there already an owner for this concept, declared or not?"),
which is the semantic, agent-specific question.

### 2.4 Inter-procedural dataflow / taint → silent-fallback, injection, value-reaches-sink

**The method.** A **Code Property Graph** (Yamaguchi et al.: AST+CFG+PDG unified) queried for
source→sink reachability. Tools: **Joern** (open-source CPG, supports JS/TS, *fuzzy parsing* so it
works on partial/uncompilable code), **CodeQL** (whole-program DB, QL/Datalog, best precision on
dynamic languages), **Semgrep** taint mode (lightest, 35+ languages)
([Joern](https://docs.joern.io/code-property-graph/),
[taint benchmark, arXiv:2506.06247](https://arxiv.org/html/2506.06247v1),
[Semgrep vs CodeQL](https://konvu.com/compare/semgrep-vs-codeql)).

**The evidence to respect.** On JS, the gap between tools is enormous: on `securibench-micro.js`,
Joern scored **F1 0.856** while Semgrep scored **0.081** (missing 112 of ~117 flows). But *all*
engines over-fire on dynamic languages — on OWASP Benchmark, CodeQL flagged 68% and Semgrep 75% of
*non-vulnerable* cases; notably, **LLM post-filtering cut false positives from >92% to 6.3%**
([Sifting the Noise, arXiv:2601.22952](https://arxiv.org/pdf/2602.04165),
[AdaTaint, arXiv:2511.04023](https://arxiv.org/pdf/2511.04023)). Joern itself, to stay sound, assumes
unknown methods propagate taint everywhere — costly FPs in dynamic TS.

**Why it fits.** "Does the caught error flow to a real sink or nowhere" (silent-fallback) and "does
this request param reach this query unescaped across two helpers" (injection) are textbook taint
queries. The system's 800-line single-file SQL escaper-reachability function is a hand-rolled,
intra-procedural approximation of what a flow engine does generally.

**The gap / the move.** Do **not** hand-roll IFDS. The research-backed move is to **delegate** flow to
CodeQL/Joern and keep antidrift as the *policy + evidence + governance* layer over their facts. The
2026 neuro-symbolic pattern is now well-quantified and is exactly this division of labor: **IRIS**
(LLM infers taint specs → CodeQL flow → LLM triages alerts), **ZeroFalse** (LLM filters false
positives), and a 2026 CI/CD study reporting hybrid LLM-augmented SAST improving detection **2.5x**
while cutting false positives **up to 91%** ([IRIS, arXiv:2405.17238](https://arxiv.org/pdf/2405.17238),
[ZeroFalse, arXiv:2510.02534](https://arxiv.org/html/2510.02534),
[SAST+LLM in CI/CD, 2026](https://science.lpnu.ua/ictee/all-volumes-and-issues/volume-6-number-1-2026/sast-improvements-using-llm-cicd-pipelines)).
Two caveats for our adoption: CodeQL needs a compilable repo (Joern's fuzzy parsing avoids this), and
the LLM triage is precisely the probabilistic layer that must stay **triage, never the blocking proof.**

### 2.5 Type-driven prevention → unearned type authority (de-prioritize)

Making forks un-typecheckable (branded/nominal owners) is the most elegant posture, but it is
**gated on consumer adoption** — antidrift cannot force target repos to adopt nominal owner types.
The project's own history is the caution: a `no-cast-to-branded` rule was retired for "no real
adoption." Keep it an opt-in capability, not an investment.

---

## 3. The market gap (what's actually missing)

Mapping the landscape against the behaviors:

| Spine | Mature tools exist | TS-native? | Agent/diff-scoped? | Evidence-gated? |
|---|---|---|---|---|
| Change-relative (refactoring-aware diff) | RefactoringMiner (Java), GumTree | **no** | no | no |
| Clone detection | NiCad, SourcererCC | partial | no | no |
| Repo-graph / reflexion | ArchUnit, dependency-cruiser, Deptrac | yes (rules only) | no (no owner discovery) | no |
| Dataflow / taint | CodeQL, Joern, Semgrep | yes | no | no (high FP) |
| AI code review | CodeRabbit, Checkmarx, LlamaFirewall | yes | yes | **no — LLM-judge, not provable** |
| AI-erosion (2026 entrant) | drift, Archyl | drift: Python; Archyl: any | yes | drift: yes (det.); Archyl: no (LLM/MCP) |

Two clusters exist in the market: **(a)** deterministic single-spine tools (CodeQL, dependency-cruiser,
RefactoringMiner, and now *drift* for AI-erosion) each solving one bucket for security, refactoring,
or architecture, none scoped to a change against an *owner registry* and none in TS with the full
spine set; and **(b)** the new AI-code-review platforms (CodeRabbit, Checkmarx Assist,
LlamaFirewall/CodeShield, Archyl), which *are* agent- and diff-aware but are **LLM judges, MCP context,
or gateway policy** — exactly the heuristic/non-provable class a deterministic guardrail wants to
avoid. Standards (NIST AI RMF, EU AI Act 2024/1689, OWASP LLM Top 10) demand governance but specify
*process*, not *proofs*.

**The 2026 consensus is on our side.** The field has converged on a *layered* model: deterministic
static analysis and test-runners for everything machine-checkable, LLM-judge reserved for genuinely
semantic checks behind an *explicit boundary* — *"not vibes, not hopeful prompting, but actual checks,
deterministic constraints"* ([jvaneyck, 2026](https://jvaneyck.wordpress.com/2026/02/22/guardrails-for-agentic-coding-how-to-move-up-the-ladder-without-lowering-your-bar/)).
Capital is following: CodeIntegrity raised $5M for *deterministic* agentic-AI guardrails, explicitly
*"rather than relying on probabilistic checks"* ([GeekWire, 2026](https://www.geekwire.com/2026/codeintegrity-raises-4-8m-to-put-permanent-guardrails-on-unpredictable-ai-agents/)).
But every 2026 entrant still sits on one side of the gap: *drift* is deterministic + cross-file but
Python-only and dependency-rule-scoped; Archyl/CodeRabbit/Checkmarx are agent-aware but
LLM-judge/MCP/policy, not provable. None is the TS-native, multi-spine, evidence-gated, owner-aware
deterministic proof layer — which is what the fact/registry spine already positions us to be.

**The open space** is the intersection none of them occupies: **deterministic, research-backed
multi-spine proofs — refactoring-aware diff + clone detection + reflexion owner-discovery + delegated
taint — unified under one frozen *fact/registry* contract, evidence-gated against real multi-repo
corpora, and scoped to a change and an owner registry, for TypeScript.** The antidrift system already
owns the two hardest non-technique assets for this: a **bucket-agnostic fact/registry spine** that can
host non-AST proofs, and a **real-corpus evidence + maturity discipline** (rules don't ship on
synthetic fixtures; promotion needs ≥2 independent repos). The techniques above plug into that spine;
the spine is the differentiator.

---

## 4. What still needs research / market validation (be honest)

1. **TS refactoring-aware diff** does not exist at RefactoringMiner quality. Is the diff-scoped
   existing-adapters bridge "good enough" for diff-scope-creep, or is a real TS refactoring miner
   required? Unknown until prototyped against the n=60 corpus.
2. **Owner discovery** (reflexion + clone detection over a concept registry) is novel framing; no tool
   does "is there already an owner for this concept?" — needs a definition of "concept identity" that
   isn't just name matching.
3. **Dynamic-TS taint FPs.** The 68–92% FP rates are real. The viable path (delegate + LLM/typed
   post-filter) reintroduces a probabilistic component — acceptable only as *triage*, never as the
   blocking proof. Where exactly is that line?
4. **Diff-relative as a `proofBucket`, not a hook.** The architecture claim — a change-context adapter
   emitting the *same* `semanticFact` into the *same* registry — is unproven until one spine is built.
   It is the cheapest falsifiable experiment and should come first.
5. **Is any of this a product, or internal tooling?** The market data says enterprises are buying
   AI-code governance now; whether deterministic multi-spine proofs beat LLM-judge convenience in the
   buyer's eyes is a positioning question, not a technical one.

---

## Sources

- AI-code governance market: [TrueFoundry](https://www.truefoundry.com/blog/best-ai-code-security) ·
  [Checkmarx 2026](https://checkmarx.com/learn/ai-security/top-12-ai-developer-tools-in-2026-for-security-coding-and-quality/) ·
  [tfir.io](https://tfir.io/ai-code-quality-2026-guardrails/) ·
  [LlamaFirewall (arXiv:2505.03574)](https://arxiv.org/pdf/2505.03574) ·
  [Needle in the Repo (arXiv:2603.27745)](https://arxiv.org/pdf/2603.27745)
- AST-diff / refactoring: [Refactoring-aware AST diff, TOSEM 2024](https://dl.acm.org/doi/10.1145/3696002) ·
  [arXiv:2403.05939](https://arxiv.org/pdf/2403.05939) ·
  [RefactoringMiner](https://www.emergentmind.com/topics/refactoringminer)
- Clone detection: [SourcererCC](https://dl.acm.org/doi/pdf/10.1145/2884781.2884877) ·
  [Clone tools survey](https://clones.usask.ca/clones/tools/) ·
  [Eclipse IIoT clones (arXiv:2603.27308)](https://arxiv.org/pdf/2603.27308) ·
  [Gitor (arXiv:2311.08778)](https://arxiv.org/pdf/2311.08778)
- Architecture conformance: [Architecture drift / reflexion (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0920548923000557) ·
  [Fitness functions](https://developersvoice.com/blog/architecture/architectural-fitness-functions-automating-governance/) ·
  [Architecture drift 2026](https://earezki.com/ai-news/2026-06-08-architecture-drift-detection-keep-your-code-aligned-with-design/) ·
  [MAPE-K conformance (arXiv:2401.16382)](https://arxiv.org/pdf/2401.16382)
- Dataflow / taint / CPG: [Joern CPG](https://docs.joern.io/code-property-graph/) ·
  [Language-agnostic taint (arXiv:2506.06247)](https://arxiv.org/html/2506.06247v1) ·
  [Semgrep vs CodeQL](https://konvu.com/compare/semgrep-vs-codeql) ·
  [AdaTaint / LLM source-sink (arXiv:2511.04023)](https://arxiv.org/pdf/2511.04023) ·
  [YASA, Ant Group (arXiv:2601.17390)](https://arxiv.org/pdf/2601.17390)
- 2026 frontier — agent PRs / scope / duplication: [GitHub: reviewing agent PRs](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/) ·
  [Sonar: AI code quality](https://www.sonarsource.com/blog/the-inevitable-rise-of-poor-code-quality-in-ai-accelerated-codebases/) ·
  [AI code quality metrics 2026](https://www.secondtalent.com/resources/ai-generated-code-quality-metrics-and-statistics-for-2026/) ·
  [AIDev / agentic PR study (arXiv:2601.17581)](https://arxiv.org/html/2601.17581)
- 2026 frontier — deterministic vs LLM-judge guardrails: [jvaneyck: guardrails for agentic coding](https://jvaneyck.wordpress.com/2026/02/22/guardrails-for-agentic-coding-how-to-move-up-the-ladder-without-lowering-your-bar/) ·
  [GeekWire: CodeIntegrity $5M deterministic guardrails](https://www.geekwire.com/2026/codeintegrity-raises-4-8m-to-put-permanent-guardrails-on-unpredictable-ai-agents/) ·
  [Willful Disobedience: detecting agentic-trace failures (arXiv:2603.23806)](https://arxiv.org/pdf/2603.23806)
- 2026 frontier — AI-erosion tooling + LLM-assisted SAST: [drift (deterministic AI-erosion analyzer)](https://github.com/sauremilk/drift) ·
  [Archyl: drift score + MCP](https://www.archyl.com/blog/ai-agents-transforming-architecture-documentation) ·
  [IRIS (arXiv:2405.17238)](https://arxiv.org/pdf/2405.17238) ·
  [ZeroFalse (arXiv:2510.02534)](https://arxiv.org/html/2510.02534) ·
  [SAST+LLM in CI/CD, 2026](https://science.lpnu.ua/ictee/all-volumes-and-issues/volume-6-number-1-2026/sast-improvements-using-llm-cicd-pipelines)
