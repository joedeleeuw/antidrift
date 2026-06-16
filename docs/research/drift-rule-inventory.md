# Drift Rule Inventory — Adversarial Analysis

Drift version inspected: `/Users/sushi/code/drift` (2026-06-16 checkout).
Reference taxonomy: `policy/registries/solve-buckets.yaml`, `docs/research-learnings.md`.

Signals are the primary detection unit in drift (`src/drift/signals/`). There are **25 signals**
enumerated in `src/drift/models/_enums.py:SignalType`. In addition, four TypeScript/JS-specific
rules live under `src/drift/rules/tsjs/` and are orchestrated via the `TS_ARCHITECTURE` signal.
The `blast_radius/` subsystem (change-detector + arch-analyzer + policy-analyzer + adr-analyzer)
is a meta-layer that classifies changed files and emits impact notices; it is not a signal itself.

---

## Signal inventory by solve-bucket category

### 1. semantic-ast

AST-resident, single-file or cross-file graph proof. No git history required.

#### pattern_fragmentation (`PATTERN_FRAGMENTATION`)
- **What it detects:** Multiple incompatible implementations of the same pattern category (error
  handling, API endpoints, caching, etc.) within the same directory module. Claims to catch the
  "different AI sessions produced different conventions" failure mode.
- **Detection approach:** Reads `ParseResult.patterns` (pre-extracted by the ingestion layer via
  tree-sitter or `ast`). Groups `PatternInstance` objects by `PatternCategory` then by directory,
  clusters them into variants via a JSON fingerprint key, counts variants per module.
  `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** The core proof is a fingerprint-grouping heuristic, not a semantic
  equivalence check. Two handlers that catch the same exception type but differ in one log call
  will produce separate variant keys and fire a finding even if the difference is intentional. The
  `_normalize_error_handling_fingerprint` strips exception types to reduce noise, but the
  fingerprint structure itself comes from the ingestion layer's extraction heuristics — so the
  accuracy of the finding is bounded by ingestion quality, not by a first-class proof. Scores
  are adjusted by ad hoc multipliers for "framework surface" and "plugin layout" hints (path-token
  matching), which are regex on directory names, not structural proof. False-positive exposure is
  non-trivial for heterogeneous codebases.
  File: `src/drift/signals/pattern_fragmentation.py`.

#### mutant_duplicate (`MUTANT_DUPLICATE`)
- **What it detects:** Near-duplicate function bodies within the codebase — structural
  copy-paste-then-modify, the "same function written twice across AI sessions" pattern.
- **Detection approach:** Three-stage pipeline:
  1. Exact duplicate via `body_hash` — deterministic, O(n).
  2. AST Jaccard similarity on token sets — deterministic, O(n²) within LOC-buckets.
  3. Optional hybrid `0.6 × ast_jaccard + 0.4 × cosine_embedding` when
     `sentence-transformers` + FAISS are installed (opt-in via `embeddings_enabled`).
  `incremental_scope = "cross_file"` (default `repo_wide` base).
- **Type:** warn / score.
- **Adversarial note:** This is the closest drift gets to our `clone-detection` bucket. The base
  (Stage 1+2) is a genuine structural clone detector — body hash equality is exact proof; AST
  Jaccard is a principled Type-2 clone metric. The embedding tier (Stage 3) is optional and
  requires external infra; when absent drift falls back to purely structural comparison. The
  cross-workspace plugin suppression (cross-plugin pairs are silently excluded from findings)
  could mask real duplication in monorepos. The 5-LOC / complexity-≥2 floor excludes most
  one-liner helpers, where agent-authored duplication is also common.
  File: `src/drift/signals/mutant_duplicates.py`.

#### cohesion_deficit (`COHESION_DEFICIT`)
- **What it detects:** "God files" — files whose functions/classes have low pairwise name-token
  Jaccard similarity, indicating many unrelated responsibilities in one module.
- **Detection approach:** Tokenizes function/class names (camelCase split + stopword removal),
  computes pairwise Jaccard on token sets, flags files where mean similarity is below threshold.
  Pure AST/name analysis; no body inspection. `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** Proof is name-token similarity, not semantic or behavioral cohesion.
  A file containing `fetchUser`, `updateUser`, `deleteUser`, `cacheUser` would show high cohesion;
  a file containing `parseDate`, `buildQuery`, `renderChart` would show low cohesion even if all
  three are legitimately collocated. This is a naming heuristic, not structural evidence of
  responsibility scatter.
  File: `src/drift/signals/cohesion_deficit.py`.

#### dead_code_accumulation (`DEAD_CODE_ACCUMULATION`)
- **What it detects:** Exported symbols (functions, classes) that are never imported elsewhere in
  the project — candidates for dead code left behind after AI refactors.
- **Detection approach:** Builds a cross-file import table from all `ParseResult.imports`, then
  checks whether each exported name appears as an imported name in any other file.
  `incremental_scope = "repo_wide"` (default).
- **Type:** warn / inventory.
- **Adversarial note:** This is a genuine cross-file reachability check on the import graph,
  which is more than pure per-file AST. However it is NOT inter-procedural dataflow — it only
  checks static import references, not call sites. Dynamic imports (`importlib`, `require()`
  with variable strings, re-exports via barrel files) are known false-positive sources, documented
  in the signal header. Framework entry-points invoked by config/runtime (not by import) will
  always be false-positives.
  File: `src/drift/signals/dead_code_accumulation.py`.

#### phantom_reference (`PHANTOM_REFERENCE`)
- **What it detects:** Function calls and attribute accesses referencing names that do not exist
  in the local scope or in the project-wide export table — hallucinated helpers.
- **Detection approach:** Builds a project-wide export table from all parse results, then
  walks call-site ASTs checking whether called names are in scope (local, imported, builtins,
  framework globals). `incremental_scope = "cross_file"`.
- **Type:** block / warn.
- **Adversarial note:** Genuine cross-file symbol resolution is real proof for Python. The signal
  correctly excludes stdlib, known framework globals, and builtins. However the export table is
  built from `ParseResult` data (which may lag or be incomplete), and dynamic attribute
  construction (getattr with variable names) will cause false negatives. For TypeScript this
  signal likely does not fire — the TS ingestion path uses tree-sitter, and TS already has tsc
  type checking for undefined references.
  File: `src/drift/signals/phantom_reference.py`.

#### naming_contract_violation (`NAMING_CONTRACT_VIOLATION`)
- **What it detects:** Functions whose name implies a behavioral contract that the AST does not
  fulfill — `validate_*` without a raise/return-False path, `is_*` without bool return,
  `try_*` without try/except, etc.
- **Detection approach:** Per-file AST walk. Matches function names against prefix rule sets
  (`validate_`, `ensure_`, `is_`, `has_`, `try_`, `get_or_create_`), then checks the body AST
  for the required structural evidence. `incremental_scope = "file_local"`.
- **Type:** warn.
- **Adversarial note:** This is deterministic AST proof for the named patterns. False negatives
  are high when agent code uses name conventions drift does not enumerate (e.g., `assert_*`
  without `assert` statement, or custom project conventions). The rule list is a closed set of
  ~5 patterns, not a learnable contract model.
  File: `src/drift/signals/naming_contract_violation.py`.

#### guard_clause_deficit (`GUARD_CLAUSE_DEFICIT`)
- **What it detects:** Modules where public functions uniformly lack input guard clauses
  (isinstance checks, early raise/return on bad input) and/or have excessive nesting depth.
- **Detection approach:** Per-file AST walk. Checks first N statements of each public function
  for guard clause patterns (isinstance, assert, if-raise/return). Flags when a configurable
  fraction of functions lack guards. Also counts nesting depth for excessive-nesting detection.
  `incremental_scope = "file_local"`.
- **Type:** warn.
- **Adversarial note:** The guard clause check is AST-structural. It detects _presence_ of a
  guard pattern, not whether the guard is correct or sufficient. A function with
  `if not x: return None` (a guard clause that effectively ignores invalid input via silent
  fallback) would pass the check.
  File: `src/drift/signals/guard_clause_deficit.py`.

#### fan_out_explosion (`FAN_OUT_EXPLOSION`)
- **What it detects:** Files importing an excessive number of unique modules (god-file coupling
  hub, indicating the file has too many responsibilities).
- **Detection approach:** Counts unique top-level package dependencies from `ParseResult.imports`.
  Per-file, no graph traversal. `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** Pure import-count heuristic. Does not distinguish between narrow
  purpose-specific imports and genuinely sprawling coupling. Index/barrel files are excluded.
  The threshold is configurable but arbitrary.
  File: `src/drift/signals/fan_out_explosion.py`.

#### cognitive_complexity (`COGNITIVE_COMPLEXITY`)
- **What it detects:** Functions whose cognitive complexity (SonarSource model: nesting-weighted
  control-flow increments) exceeds a configurable threshold.
- **Detection approach:** Python: `ast` recursive walk with nesting tracking. TypeScript: tree-
  sitter walk. Pure per-file AST computation. `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** Deterministic and well-specified (SonarSource model). No false-positive
  concerns specific to this signal beyond the inherent limits of static complexity metrics.
  File: `src/drift/signals/cognitive_complexity.py`.

#### bypass_accumulation (`BYPASS_ACCUMULATION`)
- **What it detects:** Files with high density of quality-bypass markers: `# type: ignore`,
  `# noqa`, `# pragma: no cover`, `cast()`, `@ts-ignore`, `as any`, `TODO`/`FIXME`/`HACK`.
- **Detection approach:** Regex line-scan over source text. Not AST-based — pure text pattern
  matching against a closed set of marker patterns. `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** This is regex text scanning, not AST analysis. "Deterministic" is correct
  but the mechanism is shallow: commented-out examples or documentation strings containing marker
  text would be counted. The density threshold is relative (median-based), which damps noise
  in consistently-suppressed codebases.
  File: `src/drift/signals/bypass_accumulation.py`.

#### broad_exception_monoculture (`BROAD_EXCEPTION_MONOCULTURE`)
- **What it detects:** Modules where _all_ exception handlers are uniformly broad (catching
  `Exception`, `BaseException`, bare `except`) and uniformly swallowing (pass/log/print without
  re-raise).
- **Detection approach:** Reads `ParseResult.patterns` (category `ERROR_HANDLING`) extracted by
  ingestion. Checks that `exception_type` and `actions` match the broad/swallowing profiles.
  `incremental_scope = "file_local"`.
- **Type:** warn.
- **Adversarial note:** Detection quality depends entirely on ingestion accuracy for pattern
  extraction. The signal correctly targets _monoculture_ (uniform across all handlers), not
  individual bad handlers, which reduces false positives. But the "swallowing" detection is
  pattern-based on `actions` lists from ingestion, not a dataflow proof that the error
  actually reaches no real sink.
  File: `src/drift/signals/broad_exception_monoculture.py`.

#### test_polarity_deficit (`TEST_POLARITY_DEFICIT`)
- **What it detects:** Test suites that contain only happy-path assertions and no negative tests
  (`pytest.raises`, `assertFalse`, boundary/edge test names).
- **Detection approach:** Per-file AST walk on test files. Counts negative assertion methods,
  `pytest.raises` usage, and boundary-keyword function names. `incremental_scope = "file_local"`.
- **Type:** warn.
- **Adversarial note:** Correct for the named assertion frameworks. Projects using custom
  assertion utilities or non-standard frameworks (Jest `expect().toThrow()` shape variants)
  may produce false negatives. The boundary-keyword detection is name-based, not semantic.
  File: `src/drift/signals/test_polarity_deficit.py`.

#### explainability_deficit (`EXPLAINABILITY_DEFICIT`)
- **What it detects:** High-complexity functions that lack documentation (no docstring) and have
  no co-located test file, especially when AI-attributed.
- **Detection approach:** Per-file: checks `FunctionInfo.docstring`, `FunctionInfo.complexity`
  from ingestion, and presence of sibling test files on disk. Git history used only to check
  `ai_attributed_commits` ratio — no diff analysis. `incremental_scope = "file_local"`.
- **Type:** warn.
- **Adversarial note:** The "no test" check is a file-existence check (looks for conventional
  sibling test file names). It does not verify that any test actually exercises the function.
  File: `src/drift/signals/explainability_deficit.py`.

#### hardcoded_secret (`HARDCODED_SECRET`)
- **What it detects:** Variable assignments with security-sensitive names paired with string
  literals having known API token prefixes or high Shannon entropy.
- **Detection approach:** Python: `ast` assignment node walk + regex on variable names + entropy
  filter. TypeScript: tree-sitter. Pure per-file AST + regex. `incremental_scope = "file_local"`.
- **Type:** block.
- **Adversarial note:** This is the standard "secretname + string literal" heuristic, not
  dataflow taint. Secrets stored in environment variables read at runtime, passed through
  function parameters, or assigned to non-standard variable names will not be detected.
  High false-positive risk for test files (handled by exclusion), ML tokenizer special-token
  names (explicitly excluded), and placeholder strings (regex-excluded).
  File: `src/drift/signals/hardcoded_secret.py`.

#### insecure_default (`INSECURE_DEFAULT`)
- **What it detects:** Insecure configuration defaults: `DEBUG = True`, `ALLOWED_HOSTS = ["*"]`,
  `CORS_ALLOW_ALL_ORIGINS = True`, `verify=False` in requests, `cors({ origin: '*' })`, etc.
- **Detection approach:** Per-file AST (Python `ast` / tree-sitter for TS). Matches specific
  assignment names against specific constant values. `incremental_scope = "file_local"`.
- **Type:** block / warn.
- **Adversarial note:** Deterministic and low false-positive for the covered patterns. Coverage
  is a closed enumerated list — novel insecure defaults or framework-specific patterns not in
  the list are missed. Not dataflow: a setting read from `os.environ.get("DEBUG")` with a
  `True` default would not be detected.
  File: `src/drift/signals/insecure_default.py`.

#### missing_authorization (`MISSING_AUTHORIZATION`)
- **What it detects:** API endpoint functions that lack any authorization check (no auth
  decorator, no auth mixin, no auth-named parameter).
- **Detection approach:** Uses `ParseResult.patterns` (category `API_ENDPOINT`) from ingestion to
  identify route handlers, then checks function decorators, class base names, and parameter names
  against closed sets of auth-marker patterns. `incremental_scope = "file_local"`.
- **Type:** block / warn.
- **Adversarial note:** This is presence-of-auth-marker, not dataflow reachability. A function
  that calls `verify_token(request)` internally (no decorator) but with a non-standard function
  name will be flagged as unauthorized. The auth-marker sets are closed enumerations of known
  decorator and parameter name patterns — novel auth frameworks or project-specific conventions
  will produce false positives. Does NOT prove that the auth check is correct or sufficient.
  File: `src/drift/signals/missing_authorization.py`.

#### type_safety_bypass (`TYPE_SAFETY_BYPASS`)
- **What it detects:** TypeScript type-escape-hatch accumulation: `as any`, double casts
  (`as unknown as T`), non-null assertions (`!`), `@ts-ignore`, `@ts-expect-error`.
- **Detection approach:** Tree-sitter AST walk for TS/TSX files. Counts bypass nodes. Regex
  fallback for directive comments. Threshold-based: fires when count exceeds `default_threshold`
  (5) or when file-relative density is high. `incremental_scope = "file_local"`.
- **Type:** warn / score.
- **Adversarial note:** Correct AST detection for the enumerated patterns. SDK-idiomatic bypass
  patterns (Playwright locator non-null assertions, discord.js event emitter) are heuristically
  suppressed via import-origin regex — a regex-on-import-path heuristic, not type-resolution.
  File: `src/drift/signals/type_safety_bypass.py`.

#### doc_impl_drift (`DOC_IMPL_DRIFT`)
- **What it detects:** Divergence between ADR/README documentation (referenced paths, modules,
  patterns) and what actually exists on disk — documentation that claims paths or module names
  that are gone or renamed.
- **Detection approach:** Parses Markdown (via `mistune` AST) extracting links, code blocks, and
  prose module references. Checks that referenced file paths exist on disk. Optional
  embedding-based claim validation (opt-in). `incremental_scope = "file_local"`.
- **Type:** warn / inventory.
- **Adversarial note:** The primary proof is path-existence on disk — a genuine check.
  The embedding-based "claim validation" is opt-in and uses semantic similarity to assess
  whether prose claims align with code; this is inherently probabilistic, not deterministic.
  The URL-segment blacklist (to avoid false-positives from badge/CI links) is a manual list
  that will miss novel URL shapes.
  File: `src/drift/signals/doc_impl_drift.py`.

#### circular_import (`CIRCULAR_IMPORT`)
- **What it detects:** Circular import chains within Python packages.
- **Detection approach:** Builds a directed import graph from `ParseResult.imports` for all
  Python files, runs elementary cycle detection via DFS. Filters cycles to those where all
  participants are local modules. `incremental_scope` defaults to `"repo_wide"`.
- **Type:** block / warn.
- **Adversarial note:** Genuine graph-cycle proof for Python. For TypeScript/JS, this is handled
  by the `TS_ARCHITECTURE` signal via `circular_module_detection.py` in `rules/tsjs/`, which
  uses `build_relative_import_graph` (regex-based static import extraction, not tsc module
  resolution). Alias resolution (tsconfig `paths`) is attempted but complex alias patterns will
  be missed.
  File: `src/drift/signals/circular_import.py`.

#### ts_architecture (`TS_ARCHITECTURE`) — wrapper
- **What it detects:** Orchestrates four TS/JS rules:
  1. `circular_module_detection` — cycle detection on TS import graph.
  2. `cross_package_import_ban` — forbidden cross-package imports in monorepos.
  3. `layer_leak_detection` — upward layer imports violating configured order.
  4. `ui_to_infra_import_ban` — UI files importing infrastructure modules.
- **Detection approach:** Builds a whole-repo TS import graph via regex (`_IMPORT_FROM_RE`),
  then evaluates each rule against it. The workspace-package mapping uses `package.json`
  discovery on disk (`assign_ts_sources_to_workspace_packages`). Layer and package
  configuration must be provided by the user in a JSON config file.
  `cache_dependency_spec.scope = "repo_wide"`.
- **Type:** block / warn.
- **Adversarial note:** The import graph is built from regex extraction of `import ... from`
  statements — NOT from the TypeScript compiler's module resolution. This means tsconfig
  `paths` aliases, barrel re-exports, and dynamic `require()` calls are either partially
  handled (alias resolver) or missed. Layer and package assignments require user-maintained
  JSON config; without it, the cross-package and layer-leak rules emit no findings. This is a
  genuine dependency-graph signal, but its accuracy is bounded by regex import parsing.
  Files: `src/drift/signals/ts_architecture.py`, `src/drift/rules/tsjs/`.

---

### 2. diff-relative / change-aware

Signals that require git history or cross-commit comparison.

#### temporal_volatility (`TEMPORAL_VOLATILITY`)
- **What it detects:** Files with statistically anomalous churn, author diversity, or
  defect-correlated commit frequency over a 30-day rolling window. Boosted when AI-attributed.
- **Detection approach:** Reads `FileHistory` objects populated by `ingestion/git_history.py`
  (calls `git log --follow --numstat` per file, attributes commits to AI via `Co-Authored-By`
  header regex). Computes z-scores for change frequency, author count, and defect commit count
  across the repo baseline. `incremental_scope = "git_dependent"`.
- **Type:** warn / score.
- **Adversarial note:** This is a genuine git-history-based signal — the only one that uses
  defect correlation (commit message keywords). However the AI attribution is heuristic
  (commit message patterns + Co-authored-by markers) and has no ground truth. The z-score
  approach is statistically sound but requires a non-trivial commit history to produce
  meaningful baselines; shallow clones silently return empty results. Plugin workspace
  dampening uses coordinated-burst detection (% of files recently modified) — a reasonable
  heuristic but can suppress real volatility in actively-developed plugins.
  File: `src/drift/signals/temporal_volatility.py`.

#### exception_contract_drift (`EXCEPTION_CONTRACT_DRIFT`)
- **What it detects:** Public functions whose exception profile (raised types, caught types) has
  changed across recent commits while the signature (name + arity) remained stable — silent
  contract changes.
- **Detection approach:** Uses `git show <prev_sha>:<file_path>` (subprocess) to retrieve the
  previous version of each file, then compares per-function exception AST profiles between
  current and previous version. `incremental_scope = "git_dependent"`.
- **Type:** warn.
- **Adversarial note:** This is a genuine diff-relative check — one of the only signals in drift
  that actually compares two AST versions of a file. However the "previous version" is the
  prior git-indexed version (not the merge-base), so it detects any committed change, not just
  the current PR diff. Requires non-shallow clone. One `git show` subprocess per file is O(n)
  process spawning — a performance concern at scale.
  File: `src/drift/signals/exception_contract_drift.py`.

#### co_change_coupling (`CO_CHANGE_COUPLING`)
- **What it detects:** File pairs that repeatedly change together in commits without having an
  explicit import relationship — hidden coupling that bypasses the module graph.
- **Detection approach:** Reads `CommitInfo` objects from `FileHistory.commits` (populated by
  `ingestion/git_history.py`). Counts co-occurrence in commits, computes weighted confidence
  score, then cross-checks against the import graph to suppress pairs that have explicit
  imports. `incremental_scope = "git_dependent"`.
- **Type:** warn / inventory.
- **Adversarial note:** This is a genuine change-mining / coupling signal. Co-change analysis
  is a well-studied technique (association rule mining on commit sets). The key claim —
  "changed together without explicit import" — is real proof of hidden coupling, not a naming
  heuristic. Limitations: bot commits (dependabot, release-please) are down-weighted but not
  excluded; merge commits are weighted at 0.35; the minimum window is `_MIN_HISTORY_COMMITS = 8`
  which silently returns nothing on new repos.
  File: `src/drift/signals/co_change_coupling.py`.

#### system_misalignment (`SYSTEM_MISALIGNMENT`)
- **What it detects:** Recently modified files that introduce third-party imports not established
  in the module's baseline dependency set — "agent changed the dependency envelope."
- **Detection approach:** Builds a per-directory import baseline from `FileHistory` for files
  older than `recency_days` (default 14), then flags recently-modified files that import
  packages absent from the baseline. `incremental_scope = "git_dependent"`.
- **Type:** warn / score.
- **Adversarial note:** This is a change-relative signal: it compares the recent import set
  against a historical baseline, which is genuinely change-aware. However "recency" is
  determined by `FileHistory.last_modified` (last commit date), not by whether the import was
  added in the current PR. An import added 30 days ago in an otherwise untouched file would
  not be detected. The baseline is also per-directory (not per-module), so a module-level
  novel import in a mixed-age directory may be masked by older sibling files.
  File: `src/drift/signals/system_misalignment.py`.

---

### 3. dependency-graph

Whole-repo module graph analysis. Drift's primary architecture enforcement layer.

The `TS_ARCHITECTURE` signal (listed above under semantic-ast) also belongs here for its
cycle-detection and cross-package-import-ban components. The `ARCHITECTURE_VIOLATION` signal
is the Python-side equivalent.

#### architecture_violation (`ARCHITECTURE_VIOLATION`)
- **What it detects:** Python imports that violate configured layer boundaries (e.g., a route
  handler importing from a database module).
- **Detection approach:** Builds a directed import graph from `ParseResult.imports` using
  `networkx`. Detects boundary violations by mapping modules to layers via config. Co-change
  history is used to dampen hub-module findings. Optional embedding-based layer inference when
  `sentence-transformers` is installed (`uses_embeddings = True`).
  `cache_dependency_spec.scope = "repo_wide"`.
- **Type:** warn / block.
- **Adversarial note:** The base layer-violation check is a genuine import-graph traversal —
  stronger than per-file AST. Layer assignments require user configuration. The embedding-based
  layer _inference_ (when no explicit config exists) uses cosine similarity between module path
  tokens and layer-prototype descriptions — this is probabilistic, not deterministic. The claim
  "architecture violation" implies a structural conformance model; without explicit layer config
  the finding rests on a semantic similarity heuristic.
  File: `src/drift/signals/architecture_violation.py`.

---

### 4. blast_radius subsystem (meta-layer, not a signal)

`src/drift/blast_radius/` is an impact-classification layer invoked around PR/commit boundaries.
It is not a signal and does not produce `Finding` objects in the main pipeline.

- **_change_detector.py:** Runs `git diff --name-only <ref>..<head>` plus working-tree diff to
  enumerate changed files. Deterministic, stdlib-only, no LLM.
- **_arch_analyzer.py:** Loads `ArchGraph` (a persisted module dependency graph) and finds
  transitive consumers of changed modules. Provides "module X depends on changed module Y —
  re-validate" impact notices.
- **_policy_analyzer.py:** Glob-matches changed file paths against policy rules (e.g., changes
  to `src/drift/signals/**` require audit artifact updates). Emits `BlastImpact` notices.
- **_adr_analyzer.py:** Detects changes near ADR decision records and flags potential doc drift.

**This is the most genuinely change-aware layer in drift**, but it is advisory (produces
`BlastImpact` notices for agents/reviewers, not blocking findings in the CI gate by default).
The arch impact analysis requires a pre-built `ArchGraph` artifact — without it, the analyzer
silently skips with a degradation note.

---

### 5. dataflow-taint

Drift has **no signals in this bucket**. `hardcoded_secret`, `insecure_default`, and
`missing_authorization` are the closest, but all use AST pattern matching, not inter-procedural
dataflow. `broad_exception_monoculture` checks swallowing patterns via ingestion-layer action
lists, not taint.

---

### 6. clone-detection

`mutant_duplicate` is the primary signal here (see semantic-ast above). The base (body-hash
+ AST Jaccard) is genuine structural clone detection. Embedding-based semantic clone detection
is opt-in and infrastructure-gated (requires sentence-transformers + FAISS). There is no
cross-repo clone detection or Type-3 semantic clone detection in the deterministic tier.

---

### 7. type-prevention

Drift has no signals that make illegal states unrepresentable at the type level. `type_safety_bypass`
detects _avoidance_ of the type system but does not enforce branded/nominal types.
`naming_contract_violation` is a naming-contract check, not a type-system enforcement.

---

### 8. agent-ops

Drift has no equivalent to our agent-ops bucket (runtime hooks intercepting shell/edit/stop
events). The `blast_radius/_policy_analyzer.py` emits pre-commit gate notices but does not
intercept agent tool calls at runtime.

---

## Gaps: our cataloged behaviors drift does NOT cover

### diff-scope-creep (our gap: n=60, needs diff-relative)

Drift has no signal that measures whether a PR changes more code than justified by its stated
intent (the #1 measured behavior in our sweep). `system_misalignment` detects novel imports in
recently-modified files, which is adjacent, but it does not compare PR size or scope to a
stated intent or to the change's functional surface. `temporal_volatility` detects high _churn_
over time, not scope creep in a single PR.

Concrete example: an agent asked to "fix the loading state in `UserTable`" rewrites
`UserTable.tsx`, `UserTableRow.tsx`, `UserTableEmpty.tsx`, `UserCard.tsx`, and adds a new
`useUserTableState.ts` hook. No drift signal fires on any individual file — each is individually
clean — but collectively the PR has 5x the necessary scope.

### duplication / one-owner-fork (our gaps: n=31 + n=28, needs clone-detection)

`mutant_duplicate` covers structural clone detection within a repo but relies on the base AST
Jaccard metric, which is Type-2 (variable-renamed) at best. Near-duplicate types and interfaces
(Type-1 structural clones of type declarations, not function bodies) are not covered. Cross-file
interface/type duplication — an agent minting a new `UserRow` type structurally identical to the
existing `UserRecord` in another package — would not fire because `mutant_duplicate` targets
`FunctionInfo` objects (LOC ≥ 5, complexity ≥ 2), not type declarations.

Concrete example: agent adds `types/api-user.ts` containing `interface ApiUser { id: string; name: string; email: string; role: string }` when `models/user.ts` already exports `type User = { id: string; name: string; email: string; role: string }`. `mutant_duplicate` does not examine type declaration bodies; `PHANTOM_REFERENCE` does not fire because `ApiUser` is imported correctly; no drift signal fires.

### net-new-bias (our gap: n=25, needs dependency-graph)

Drift's `ts_architecture` and `architecture_violation` enforce _declared_ layer rules. Neither
discovers whether a newly introduced file or type is a conceptual duplicate of an existing
registry-declared owner. If an agent adds a new `services/userService.ts` when
`features/user/user.service.ts` already exists, no drift signal fires unless the user has
explicitly configured a cross-package import ban that covers both packages.

Concrete example: agent creates `lib/authUtils.ts` exporting `hashPassword`, `verifyToken`, and
`generateJwt` — functionality already owned by `security/auth.service.ts`. No layer config
marks these as the same layer. No import violation exists yet (the new file is just added).
`mutant_duplicate` does not fire because no function body is copied yet. Drift is silent.

### silent-fallback (our gap: n=24, needs dataflow-taint)

`broad_exception_monoculture` detects uniform-swallowing patterns at module scale (all handlers
swallow), but does not prove that a specific caught error fails to reach any real error sink.
`guard_clause_deficit` detects missing input validation but not error-path destinations.

Concrete example:
```typescript
async function loadConfig(): Promise<Config> {
  try {
    return await fetchConfig();
  } catch {
    return DEFAULT_CONFIG;
  }
}
```
The error is silently swallowed into a default. `broad_exception_monoculture` fires only if
the _entire module_ uses this pattern uniformly. If one other handler in the module re-raises,
BEM does not fire. `guard_clause_deficit` does not fire (no parameter guard issue). No drift
signal detects this individually.

### feature-scatter (our gap: n=13, needs dependency-graph)

Drift has no signal that detects when a domain concept (e.g., "user notifications") is
implemented across many unrelated modules rather than cohesively owned. `cohesion_deficit`
measures within-file naming similarity, not cross-file feature ownership patterns.

Concrete example: notification logic exists in `components/Header.tsx` (badge count),
`services/push.ts` (send call), `hooks/useNotifications.ts` (polling), `api/notifications.ts`
(fetch), and `store/notificationSlice.ts` (redux). Five modules, no single owner. No drift
signal fires — each file is individually cohesive, and no layer boundary is violated.

### unearned-type-authority (our gap, needs type-prevention)

No drift signal enforces or detects that a local type claims authority over a concept that has
a declared owner elsewhere. `type_safety_bypass` detects type-escape-hatch use, but not the
case where a developer simply declares a parallel type in a different file.

---

## Adversarial summary: claim vs. code mismatches

| Claim | Reality |
|---|---|
| "Pattern fragmentation detects AI session inconsistency" | Fingerprint-variant grouping on ingestion-extracted AST summaries; accuracy bounded by ingestion quality, not formal equivalence. |
| "Architecture violation detects layer violations" | True for Python with user-configured layers. For TS, import graph is regex-based (not tsc resolution); layer inference without config is embedding cosine similarity (probabilistic). |
| "Mutant duplicate detects copy-paste drift" | Body-hash and AST Jaccard are genuine structural clone metrics. Embedding tier is opt-in, infrastructure-gated. Type declaration clones (not function bodies) are not covered. |
| "Missing authorization maps to CWE-862" | Presence-of-auth-marker, not reachability proof. Non-standard auth frameworks, inline auth checks with novel names, or dependency-injected auth will all produce false positives or false negatives. |
| "Hardcoded secret is deterministic" | Correct, but detection is variable-name regex + entropy threshold — the standard shallow heuristic, not taint. Assignment to non-standard variable names or indirect assignment is missed. |
| "Exception contract drift compares commits" | True: uses `git show` subprocess for actual diff-relative comparison. Genuine diff-relative proof for exception profiles. |
| "Co-change coupling detects hidden coupling" | Genuine association-rule mining on commit history. The coupling claim is real proof, not a heuristic. |
| "Blast radius is change-aware" | True, but advisory only. ArchGraph must be pre-built; without it the arch impact analysis silently skips. |
