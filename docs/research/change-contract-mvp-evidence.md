# Change-contract MVP — validated real-evidence corpus

Real-evidence go/no-go for the change-contract spine (diff-scope-creep, n=60). NO synthetic fixtures.
Two independent passes, both real:

- **Mining + adversarial verification** — ultracode workflow `change-contract-mvp-evidence-gauntlet`
  (run `wf_f9046225-5ce`): 15 finders × 5 repos froze a scope contract from each commit's intent
  text _before_ reading the diff; every candidate adversarially verified by 3 default-refute skeptics;
  calibrated against 7 known true-negatives. Raw verdict: 8 TP / 3 repos.
- **Goals-vs-results review** — codex gpt-5.5/xhigh, read-only, independently re-opened each sha via
  `git -C <repo> show`. It **demoted 3 of the 8** raw TPs to ambiguous and confirmed **5 gold TPs**.

## Decision

**GO — the deterministic inventory core was worth building.** Real historical commits exist where a
frozen contract deterministically catches undeclared dependency / path / repo-surface drift. The MVP
kill-condition (≥2 unambiguous TPs across ≥2 repos) is met by the 5 gold TPs.

Implementation status: v0 inventory is now built and wired into the shipped package surface:
`antidrift change-contract`, `policy:inventory-change-contract`, the command-owned
`changeContractConformance` semantic fact, TS export-surface extraction, diff-scoped adapter
inventory, module graph radius inventory, package consumer verification, and `policy:verify-session`.

**NO — to any blocking gate or stable-promotion claim.** FP rate is uncharacterized (zero freshly
mined clean controls), the violation taxonomy is concentrated/singleton-heavy, and the high-yield
refactor/test/ci intent patterns were not sampled. Per the maturity ladder
(`policy/registries/rules.yaml:12`, minIndependentRepositories: 2) blocking requires ≥2-repo,
FP-characterized, no-known-FP/FN evidence. v0 stays inventory-only and non-blocking
(`docs/specs/change-contract-conformance-spine.md:53`).

## Gold TPs (5) — codex-confirmed, unanimous, structural, non-fuzzy

| repo @ sha                 | subject (frozen intent)                                       | violation                                                                                                                                      | vote |
| -------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| sudocode-main @ `cf3d9ccf` | "add spec-kit deps"                                           | adds `@copilotkit/react-core`/`react-ui`/`runtime` — a different dependency family; undeclared runtime dependency                              | 3:0  |
| sudocode-main @ `6c7c672`  | "update claude.md"                                            | also strips `.gitmodules` and deletes gitlink `references/beads` — structural repo-surface change                                              | 3:0  |
| sudocode-main @ `c2fcd1d`  | "update version incrementing script…minor version bump"       | creates **five** git submodules under `references/*` (vibe-kanban, beads, CodeMachine-CLI, claude-flow, agentapi)                              | 3:0  |
| sudocode-main @ `f722716`  | "update skill content…direct md changes"                      | adds two git submodules (`references/toad`, `references/vibe-kanban`)                                                                          | 3:0  |
| chaski @ `7f871d2`         | "fix(app): let missing-estimation items reach zero [GE-1147]" | bundles Sentry env init in `main.dart`, new `sentryEnvironmentName()`, session props, promotion-modal UX — outside the frozen pricing contract | 3:0  |

These span **2 repos** (sudocode-main ×4, chaski ×1). The dependency-family and submodule cases are
the cleanest possible deterministic proofs: a `package.json`/`.gitmodules` diff vs a narrow frozen
subject is trivially machine-checkable.

## Quarantined as ambiguous inventory (3) — NOT gold TPs

| repo @ sha                 | why demoted (codex independent read)                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| opencode @ `d68ebee`       | docs(go) subject can plausibly include rendered Go content across locales; the `language.locale()==='en'` guard removal is a real behavior change but not deterministic from subject-only intent |
| opencode @ `1772e8ee`      | LimitsGraph `req` 1400→3200 is runtime content data for the _same_ Go pricing surface the docs subject names; rests on reviewer judgment without a pre-frozen docs-only contract                 |
| sudocode-main @ `df6bd847` | "fix tests" touching production source — "fix tests" can sometimes legitimately authorize production fixes; not a decisive non-fuzzy proof                                                       |

The opencode docs+i18n boundary is a real open question: of 8 opencode candidates sharing this
subtype, 2 were raw-TP and 4 killed — likely a co-located docs/i18n deploy convention. Needs a
repo-convention check (CONTRIBUTING/PR template) before it can be a TP, let alone a gate.

## True-negative controls (7) — all stayed clean (`correctlyClean: true`)

`sudocode-main@52dec81e` (README-only) · `sudocode-main@d0ea172b` (declared js-yaml dep;
`.sudocode/issues.jsonl` auxiliary) · `sudocode-main@0402e9eb` (declared yaml-converter src+tests) ·
`chaski@b5e18da03` (declared eslint --fix/prettier ×78) · `chaski@d6c56c0d5` (declared proto comments
and regenerated bindings) · `chaski@59e1bee78` (declared mock ERP removal) · `chaski@9da69cc59`
(declared docs diagrams). The detector did not over-fire on any.

## Caveats carried forward (block enforcement, not v0 inventory)

1. **Zero freshly-mined clean controls** → detector false-positive _rate_ is unquantified.
2. **Singleton taxonomy** → 18 of 19 subtypes appear in one repo; submodule-addition is sudocode-only;
   opencode (the soft 3rd repo) is unproven.
3. **Unsampled high-yield patterns** → refactor-claimed-but-API-changed, test-only-but-touched-src,
   ci/build-but-changed-product-code. The mine over-weighted docs-only + dep-bump.

## Next move

1. **Replay the 5 gold TPs + 7 TN controls through the built v0 spine** as a real validation corpus.
   Quarantine the opencode cases as ambiguous inventory, never gold.
2. **Before any enforcement mode:** a second targeted mine over `refactor:*` / `test:*` / `ci:*`/`build:*`
   subjects **plus a clean-control sweep** of mined non-TPs — the missing FP-characterization step.
