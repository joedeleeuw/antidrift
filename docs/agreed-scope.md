# Agreed Scope

This is the non-package-publication scope captured in the template. The later package-surface gap analysis is excluded from this artifact.

## Included clusters

| Cluster | Primary owner | Package/config home | Notes |
|---|---|---|---|
| React state shape | Frontend platform | `tooling/antidrift/src/eslint-plugin`, `apps/web`, `packages/ui` | Detect coupled `useState` waterfalls, status triplets, derived-state effects, and raw fetch-in-component patterns. |
| Type contract shape | Type platform | `tooling/antidrift/src/eslint-plugin`, `packages/domain`, `packages/contracts` | Detect `getPointFromBag` wrappers, one-off aliases, inline structural use-site contracts, unsafe cast chains, and branded/appeasement casts. |
| Abstraction and file shape | Architecture | `policy/agent-guardrails.yaml`, Sonar | Control one-use helpers, file/component/function size, high-touch file growth. |
| Side effects and boundaries | Platform | `packages/gateways`, `packages/api`, ESLint boundaries | Prevent direct SDK, DB, env, and raw network access from the wrong layer. |
| Error handling | Reliability | ESLint custom rules and Sonar | Block silent catches, console-only handling, fallback-to-empty, lost error cause. |
| Test integrity | Quality | ESLint, Vitest | Block `.only`, conditional assertions, no-assertion tests, skipped tests without a reason. |
| Design system | Design system | `packages/ui`, registry files, ESLint custom rules | Prefer semantic tokens; block raw Tailwind colors and pointer-target hover transforms. |
| Agent ops | Developer experience | `.claude/settings.json`, `.codex/hooks.json`, `tooling/antidrift/src/policy` | PreToolUse/PostToolUse/Stop checks for policy tampering and deterministic verification. |
| Agent instructions | Developer experience | `policy/agent-guardrails.yaml`, generated markdown/rules | One source generates AGENTS, CLAUDE, Cursor, Codex, and Copilot guidance. |
| Semantic architecture drift | Architecture | ESLint boundaries, registries, Sonar external issues | Prevent cross-layer imports, deep imports, cycles, high-fan-in growth, feature scatter. |
| Domain model drift | Domain platform | `policy/registries/domain.yaml`, `packages/domain` | Prevent duplicate domain statuses, roles, and overlapping models. |
| Contract/schema drift | API platform | `packages/contracts`, `packages/api` | Keep handlers, validators, generated types, and consumers aligned. |
| Dependency/supply-chain drift | Platform security | hooks, `policy/registries/dependencies.yaml` | New runtime deps and direct SDK imports need approval. |
| Authorization/control drift | Security | `packages/api`, `policy/registries/boundaries.yaml` | Routes/actions/jobs require auth, tenant, schema, and ownership checks. |
| Observability drift | Reliability | hooks, ESLint, `packages/api` | New async/server boundaries need context and trace/log discipline. |
| Performance/resource drift | Performance | ESLint custom rules and review agents | Catch await-in-loop IO, unbounded Promise.all, missing timeouts, server packages in client. |
| Data lifecycle drift | Data platform | migration/fixture policy placeholders | Schema/model changes require migration, seed, and fixture alignment. |
| Quality-gate drift | Developer experience | hooks, CI, Sonar | Agents must not weaken policy files, lint config, type config, CI, or Sonar. |
| MCP/tooling drift | Platform security | `policy/registries/mcp.yaml` | MCP and tool config changes are executable supply-chain changes. |
| Sonar governance | Engineering productivity | `sonar-project.properties`, `sonar/` | Use Sonar for PR gates, trends, coverage, duplication, complexity, and imported policy issues. |

## Excluded from this ZIP

The following package-publication gap tooling is intentionally not included here:

- `@arethetypeswrong/cli`
- `publint`
- `validate-package-exports`
- package tarball checks
- consumer project matrix runner
- public npm package surface gates

Those belong in the separate package-surface addendum, not this monorepo guardrails baseline.
