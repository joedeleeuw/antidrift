# Agreed Scope

This is the non-package-publication scope captured in the template. The later package-surface gap analysis is excluded from this artifact.

## Included clusters

| Cluster                       | Primary owner            | Package/config home                                                            | Notes                                                                                                                                                                                |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| React state shape             | Frontend platform        | `tooling/antidrift/src/eslint-plugin`, `apps/web`, `packages/ui`               | Detect coupled `useState` waterfalls, status triplets, derived-state effects, and raw fetch-in-component patterns.                                                                   |
| Type contract shape           | Type platform            | `tooling/antidrift/src/eslint-plugin`, `packages/domain`, `packages/contracts` | Detect `getPointFromBag` wrappers, one-off aliases, inline structural use-site contracts, unsafe cast chains, and branded/appeasement casts.                                         |
| Abstraction and file shape    | Architecture             | `policy/agent-guardrails.yaml`, `antidrift oxlint`, Sonar                      | Control local complexity/depth/parameter budgets, one-use helpers, file/component/function size, and high-touch file growth.                                                         |
| Side effects and boundaries   | Platform                 | `packages/gateways`, `packages/api`, Oxlint boundaries                         | Prevent direct SDK, DB, env, and raw network access from the wrong layer.                                                                                                            |
| Error handling                | Reliability              | Oxlint baseline rules, future custom rules, and Sonar                          | Keep baseline empty-catch/console and `preserve-caught-error` protections; future custom work should target fallback-to-empty rather than owning a low-utility silent-catch matcher. |
| Test integrity                | Quality                  | Oxlint, Vitest                                                                 | Block `.only`, conditional assertions, no-assertion tests, skipped tests without a reason.                                                                                           |
| Design system                 | Design system            | `packages/ui`, future authority-backed tooling                                 | Prefer semantic tokens. Raw Tailwind color and hover-translate samplers are retired until project authority can be proved.                                                           |
| Agent ops                     | Developer experience     | `.claude/settings.json`, `.codex/hooks.json`, `tooling/antidrift/src/policy`   | PreToolUse/PostToolUse/Stop checks for policy artifact protection and deterministic verification.                                                                                    |
| Agent instructions            | Developer experience     | `policy/agent-guardrails.yaml`, generated markdown/rules                       | One source generates AGENTS, CLAUDE, Cursor, Codex, and Copilot guidance.                                                                                                            |
| Semantic architecture drift   | Architecture             | Oxlint boundaries, registries, Sonar external issues                           | Prevent cross-layer imports, deep imports, cycles, high-fan-in growth, feature scatter.                                                                                              |
| Domain model drift            | Domain platform          | `policy/registries/domain.yaml`, `packages/domain`                             | Prevent duplicate domain statuses, roles, and overlapping models.                                                                                                                    |
| Contract/schema drift         | API platform             | `packages/contracts`, `packages/api`                                           | Keep handlers, validators, generated types, and consumers aligned.                                                                                                                   |
| Dependency/supply-chain drift | Platform security        | hooks, `policy/registries/dependencies.yaml`                                   | New runtime deps and direct SDK imports need approval.                                                                                                                               |
| Authorization/control drift   | Security                 | `packages/api`, `policy/registries/boundaries.yaml`                            | Routes/actions/jobs require auth, tenant, schema, and ownership checks.                                                                                                              |
| Observability drift           | Reliability              | hooks, policy research, `packages/api`                                         | New async/server boundaries need context and trace/log discipline; no source rule currently owns this cluster.                                                                       |
| Performance/resource drift    | Performance              | Oxlint, reduced ESLint TypeChecker pass, review                                | Oxlint owns broad await-in-loop; redundant Zod validation is typed custom enforcement. Unbounded Promise.all and missing timeout rules remain gaps.                                  |
| Data lifecycle drift          | Data platform            | migration/fixture policy placeholders                                          | Schema/model changes require migration, seed, and fixture alignment.                                                                                                                 |
| Quality-gate drift            | Developer experience     | hooks, CI, Sonar                                                               | Agents must not weaken policy files, lint config, type config, CI, or Sonar.                                                                                                         |
| MCP/tooling drift             | Platform security        | `policy/registries/mcp.yaml`                                                   | MCP and tool config changes are executable supply-chain changes.                                                                                                                     |
| Sonar governance              | Engineering productivity | `sonar-project.properties`, `sonar/`                                           | Use Sonar for PR gates, trends, coverage, duplication, cognitive complexity, and imported policy issues.                                                                             |

## Excluded from this ZIP

The following package-publication gap tooling is intentionally not included here:

- `@arethetypeswrong/cli`
- `publint`
- `validate-package-exports`
- package tarball checks
- consumer project matrix runner
- public npm package surface gates

Those belong in the separate package-surface addendum, not this monorepo guardrails baseline.
