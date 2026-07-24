# Agent Guardrails Monorepo Template

A pnpm TypeScript monorepo template for making agent-authored code fail fast at the IDE, hook, CI, and SonarQube layers.

This template intentionally excludes the later package-publication surface gap work for consuming monorepos: no `arethetypeswrong`, `publint`, `validate-package-exports`, or package export matrix is part of the baseline. The `@joedeleeuw/antidrift` package itself has a focused tarball consumer test under `pnpm test:integration`.

## What is included

- pnpm workspace catalogs for consistent dependency versions.
- Oxlint for native and type-aware JavaScript/TypeScript feedback, plus a reduced ESLint pass for custom TypeChecker-backed policy rules.
- A default-off `no-duplicated-object-field-blocks` rule for repeated Zod and TypeScript shape fields that should be hoisted into a shared shape.
- Declarative source of truth in `policy/agent-guardrails.yaml`.
- Positive build recipes in `docs/build-patterns.md` so agents import or derive concepts instead of duplicating them.
- Feature planning template in `docs/feature-slice-template.md`.
- Policy coverage tracking in `docs/policy-coverage.md`.
- Self-hosting risk controls in `docs/self-hosting-risks.md`.
- Generated agent instruction targets: `AGENTS.md`, `CLAUDE.md`, Cursor rules, Claude hooks, Codex hooks, and Copilot instructions.
- Sample packages that exercise the agreed rule families.
- SonarQube configuration and generic external issue import plumbing.

## Workspace shape

```txt
apps/web                         React app using the allowed UI/domain/client boundaries
packages/domain                  Canonical domain roles, statuses, and entities
packages/contracts               Shared Zod contracts and typed API payloads
packages/api                     Server route/action boundary examples
packages/ui                      Design-system components and semantic tokens
packages/gateways                Approved SDK/client integration boundary examples
tooling/antidrift                @joedeleeuw/antidrift: Oxlint/ESLint configs, plugins, policy CLI, and hooks
policy/                          Source-of-truth policy and registries
docs/                            Handoff, agreed scope, rule authoring, Sonar guidance
```

## First install

```bash
corepack enable
pnpm install
pnpm policy:generate
pnpm check
```

## Daily commands

```bash
pnpm lint              # Oxlint baseline, custom syntax policy, then custom typed ESLint rules
pnpm typecheck         # TypeScript project references
pnpm test              # Vitest
pnpm policy:generate   # regenerate AGENTS/CLAUDE/Cursor/Codex/Copilot policy artifacts
pnpm policy:check-registries
pnpm policy:check-rule-surface
pnpm policy:validate-corpus
pnpm policy:validate-chaski # optional local real-corpus gate when CHASKI_REPO is available
pnpm policy:repo-corpus -- --slice current-work --rules import/no-cycle
pnpm policy:verify-session
pnpm sonar:prepare     # create Sonar external issues for the custom typed ESLint remainder
```

## Design principle

Instruction files tell agents what to do. Linters, hooks, type checks, tests, architecture checks, and Sonar gates prevent agents from doing the wrong thing.
