# Antidrift

A native Rust TypeScript/JavaScript semantic linter (`antidrift-linter`, built on `tsrs`) and Oxlint governance toolkit designed to catch architectural, boundary, and contract drift in AI-assisted and human codebases.

## What is included

- **Single-pass native Rust rule engine (`crates/antidrift-kernel`, `crates/antidrift-rules`, `crates/antidrift-engine`):** All 83 `antidrift/*` rules run in a single unified pass over `tsrs` (`tsrs_ast`, `tsrs_compiler`, `tsrs_checker`, and `tsrslint`), invoked automatically by `antidrift oxlint` via `OXLINT_TSGOLINT_PATH`.
- **Rust self-governance (`antidrift-linter rust`):** Enforces crate/kernel DAG layering, file-size budgets (`<= 500` non-blank lines), strict `serde` decoding (`deny_unknown_fields`), no stringly-typed enums, no boolean maps, no anemic errors, no compatibility shims, and no pass-through wrapper functions across the Rust workspace.
- **Declarative policy & registries (`policy/agent-guardrails.yaml`, `policy/registries/*.yaml`):** Generates `AGENTS.md`, `CLAUDE.md`, Claude hooks, Codex hooks, and Copilot instructions from a single source of truth.
- **Packed consumer verification (`pnpm package:verify`):** Packs `@joedeleeuw/antidrift` and verifies installation, `tsc` under `Bundler` and `NodeNext`, runtime imports, and live `antidrift oxlint` enforcement in an isolated consumer monorepo.

## Workspace shape

```txt
crates/antidrift-kernel          Shared tsrs AST, TypeChecker, boundary, projection, shape, and callgraph kernel
crates/antidrift-rules           All 83 native Rust antidrift/* rules across 8 rule families
crates/antidrift-engine          CLI, tsgolint headless host, engine session and native syn Rust self-linter
crates/antidrift-linter          antidrift-linter binary over antidrift-engine
crates/antidrift-napi            Node addon over the engine session, loaded by the Oxlint plugin
tooling/antidrift                @joedeleeuw/antidrift npm package (Oxlint config, policy CLI, brand kit)
apps/web                         React sample app exercising UI/domain/client boundaries
packages/domain                  Canonical domain roles, statuses, and entities
packages/contracts               Shared Zod contracts and typed API payloads
packages/api                     Server route/action boundary examples
packages/ui                      Design-system components and semantic tokens
packages/gateways                Approved SDK/client integration boundary examples
policy/                          Source-of-truth policy and registries
docs/                            Architecture, rule status registry, and build patterns
```

## First install

```bash
corepack enable
pnpm install
pnpm policy:generate
pnpm policy:verify-session
```

## Daily commands

```bash
pnpm lint                      # Unified Oxlint + native antidrift-linter (TS/JS) + antidrift-linter rust
pnpm lint:oxlint               # Run antidrift oxlint across the repository
pnpm lint:rust                 # cargo fmt + cargo clippy + antidrift-linter rust
pnpm parity:rust               # Run portable batch cases, headless tsrs probes, and Rust linter smokes
pnpm typecheck                 # TypeScript project references
pnpm package:verify            # Build, pack, and verify @joedeleeuw/antidrift in a consumer monorepo
pnpm policy:generate           # Regenerate AGENTS.md, CLAUDE.md, hooks, and Copilot instructions
pnpm policy:check-registries   # Validate policy/registries/*.yaml and package surface
pnpm policy:verify-session     # Full session gate (policy + lint + typecheck + rust parity)
```

## Design principle

Instruction files tell agents what to do. Deterministic AST + `TypeChecker` rules, boundary decoders, and architecture gates prevent agents from doing the wrong thing.
