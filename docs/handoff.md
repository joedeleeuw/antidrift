# Agent Handoff

## Objective

Turn repeated agent review failures into deterministic repository feedback. Agents should receive immediate local failures from ESLint custom rules, TypeScript, tests, hooks, and Sonar external issue reports.

## Operating rules for future agents

1. Do not edit generated policy artifacts directly. Edit `policy/agent-guardrails.yaml` and run `pnpm policy:generate`.
2. Do not weaken lint, typecheck, test, CI, Sonar, hook, or policy configuration unless the task explicitly includes `[policy-change]`.
3. Do not add runtime dependencies unless the task explicitly asks for it and the dependency is added to `policy/registries/dependencies.yaml`.
4. Do not use `any`, `as unknown as`, silent catches, `.only`, skipped tests, raw SDK imports outside gateways, or client/server boundary violations.
5. Run `pnpm policy:verify-session` before ending a substantial coding task.

## Implementation map

- `policy/agent-guardrails.yaml` is the editable source of truth.
- `tooling/antidrift` is the `@joedeleeuw/antidrift` package; `antidrift generate` (src/policy/) produces agent instruction files and hook configs.
- `tooling/antidrift/src/eslint-plugin` contains custom AST and type-aware semantic rules that normal linters do not know.
- `eslint.config.mjs` consumes `@joedeleeuw/antidrift/eslint-config` (TypeScript, React hooks, SonarJS, boundaries, and the custom plugin).
- `sonar-project.properties` imports generated external issues and LCOV coverage.
- `.claude/settings.json` and `.codex/hooks.json` enforce policy during agent tool use.
- `docs/build-patterns.md` is the positive construction guide. Use it before inventing a new domain, contract, API, UI resource, or gateway shape.
- `docs/feature-slice-template.md` is the lightweight planning shape for new work.
- `policy/registries/rules.yaml` is the canonical custom-rule status registry: active status, signal choice, corpus repositories, production concerns, and stable-promotion state.
- `docs/rule-status-registry.md` is the readable index for the rule status registry.
- `docs/policy-coverage.md` tracks which policy rules are enforced, partial, delegated, or still spec-only.
- `docs/real-corpus-validation.md` tracks which implemented custom rules have real Chaski-backed or fallback real-corpus evidence, and which rules remain under-proven.
- `docs/gap-inventory.md` is the synthesized current gap surface across active rule maturity, broad policy coverage, real-corpus blockers, and retired/research boundaries.
- `docs/stable-promotion-inventory.md` stack-ranks implemented rules for stable-promotion work and identifies the next advisory/inventory slice.
- `docs/self-hosting-risks.md` records the self-linting failure modes and which layer owns each control.
- `docs/roadmap.md` is limited to the hardened rules and chosen next scope: branded casts, appeasement casts, structural selector wrappers, status-triplet handling, unsafe-deserialize type signals, defensive shape probing, brand utilities, and cycle detection.

## Evidence anchors

- pnpm catalogs live in `pnpm-workspace.yaml` and support named catalogs.
- ESLint plus `typescript-eslint` is the canonical custom-rule engine because the original scope needs TypeScript `Program` and `TypeChecker` access.
- Retired-engine baseline coverage is tracked rule-by-rule in `docs/lint-rule-parity.md`; do not remove coverage without recording the replacement or accepted gap.
- Rule readiness is tracked in `policy/registries/rules.yaml`; do not call a rule stable until it has multiple independent real-repo replications that were not created for the rule, zero known false positives, zero known false negatives, no production concerns, and a grounded Claude Opus 4.8 advisory review.
- One owner per concept is the primary anti-duplication rule: import or derive from the owner instead of retyping local copies.
- `policy:check-registries` protects registry-backed rule facts; `policy:check-rule-surface` protects custom rule export/config/test alignment.
- `policy:validate-chaski` is the optional local real-corpus gate. It asserts rule behavior against explicit Chaski frontend/BFF files when `CHASKI_REPO` or `/Users/sushi/code/chaski` exists and skips otherwise.
- `policy:validate-external-corpus` is the optional fallback real-corpus gate for non-Chaski repos when Chaski has only clean controls for an implemented rule. It currently asserts Sudocode cases from `SUDOCODE_REPO` or `/Users/sushi/code/sudocode-main`, Codebase Atlas cases from `CODEBASE_ATLAS_REPO` or `/Users/sushi/code/codebase-atlas`, and Murderbox cases from `MURDERBOX_REPO` or `/Users/sushi/code/murderbox`, then skips if no external repo exists. For promotion/slice-completion breadth, run `antidrift external-corpus --min-repositories 2`.
- SonarQube should ingest custom ESLint/generic external issues instead of owning bespoke TypeScript rules directly.
- Claude Code and Codex hooks are the deterministic lifecycle layer for PreToolUse, PostToolUse, and Stop checks.
- Nx boundaries and `eslint-plugin-boundaries` are the architecture-boundary layer; this template uses `eslint-plugin-boundaries` by default to keep the sample repo lightweight.

## First agent task after unzip

1. Run `pnpm install`.
2. Run `pnpm policy:generate`.
3. Run `pnpm check`.
4. Replace sample domain registries with the real project architecture, domain roles/statuses, gateway packages, design tokens, and boundary functions.
5. Read `docs/build-patterns.md` before adding new feature slices.
6. Tighten any warning-level heuristic rules to errors once false positives are measured.
