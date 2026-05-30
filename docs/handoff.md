# Agent Handoff

## Objective

Turn repeated agent review failures into deterministic repository feedback. Agents should receive immediate local failures from Oxlint, ESLint custom rules, TypeScript, tests, hooks, and Sonar external issue reports.

## Operating rules for future agents

1. Do not edit generated policy artifacts directly. Edit `policy/agent-guardrails.yaml` and run `pnpm policy:generate`.
2. Do not weaken lint, typecheck, test, CI, Sonar, hook, or policy configuration unless the task explicitly includes `[policy-change]`.
3. Do not add runtime dependencies unless the task explicitly asks for it and the dependency is added to `policy/registries/dependencies.yaml`.
4. Do not use `any`, `as unknown as`, silent catches, `.only`, skipped tests, raw SDK imports outside gateways, or client/server boundary violations.
5. Run `pnpm policy:verify-session` before ending a substantial coding task.

## Implementation map

- `policy/agent-guardrails.yaml` is the editable source of truth.
- `tooling/antidrift` is the `@joedeleeuw/antidrift` package; `antidrift generate` (src/policy/) produces agent instruction files and hook configs.
- `tooling/antidrift/src/eslint-plugin` contains custom AST rules that normal linters do not know.
- `eslint.config.mjs` consumes `@joedeleeuw/antidrift/eslint-config` (TypeScript, React hooks, SonarJS, boundaries, and the custom plugin).
- `oxlint.config.mjs` re-exports `@joedeleeuw/antidrift/oxlint-config` for the fast first pass and strict built-in rule posture.
- `sonar-project.properties` imports generated external issues and LCOV coverage.
- `.claude/settings.json` and `.codex/hooks.json` enforce policy during agent tool use.

## Evidence anchors

- pnpm catalogs live in `pnpm-workspace.yaml` and support named catalogs.
- Oxlint covers many built-in rules and supports JS plugins, but type-aware bespoke rules should remain in ESLint until the custom-rule path is mature enough for the rule.
- ESLint custom rules are the flexible layer for project-specific semantics.
- SonarQube should ingest custom ESLint/generic external issues instead of owning bespoke TypeScript rules directly.
- Claude Code and Codex hooks are the deterministic lifecycle layer for PreToolUse, PostToolUse, and Stop checks.
- Nx boundaries and `eslint-plugin-boundaries` are the architecture-boundary layer; this template uses `eslint-plugin-boundaries` by default to keep the sample repo lightweight.

## First agent task after unzip

1. Run `pnpm install`.
2. Run `pnpm policy:generate`.
3. Run `pnpm check`.
4. Replace sample domain registries with the real project architecture, domain roles/statuses, gateway packages, design tokens, and boundary functions.
5. Tighten any warning-level heuristic rules to errors once false positives are measured.
