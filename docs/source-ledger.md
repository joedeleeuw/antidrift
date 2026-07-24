# Source Ledger

This ledger records the enforcement owner and provenance of each ruleset or tool. Detailed custom-rule maturity remains in `policy/registries/rules.yaml`; runtime ownership and migration parity live in `docs/lint-rule-parity.md`.

## Source Types

| Source type          | Meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `local-original`     | Implemented in Antidrift because no maintained equivalent covers the scoped behavior. |
| `ecosystem-ruleset`  | Pulled from a maintained native or JavaScript plugin.                                 |
| `generated-config`   | Produced from consumer-owned policy registries.                                       |
| `delegated-tool`     | Owned by TypeScript, Vitest, Sonar, hooks, or another external gate.                  |
| `consumer-tooling`   | Recommended to consumers but not bundled into Antidrift.                              |
| `borrowed-reference` | Informed by another repository but enforced through a named final owner.              |

## Current Sources

| Area                                  | Source                                                                      | Enforcement owner                               |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Native JS/TS correctness              | `ecosystem-ruleset`: Oxlint Rust rules                                      | `tooling/antidrift/src/oxlint-config/index.mjs` |
| Type-aware TypeScript lint            | `ecosystem-ruleset`: `oxlint-tsgolint` and `typescript-go`                  | Oxlint `options.typeAware`                      |
| React and React Compiler              | `ecosystem-ruleset`: Oxlint React plugin                                    | Oxlint config                                   |
| Import and Unicorn rules              | `ecosystem-ruleset`: Oxlint native plugins                                  | Oxlint config                                   |
| Vitest integrity                      | `ecosystem-ruleset`: Oxlint Vitest plugin                                   | Oxlint test override                            |
| Architecture boundaries               | `ecosystem-ruleset`: `eslint-plugin-boundaries`                             | Oxlint JavaScript plugin host                   |
| Disable-comment policy                | `ecosystem-ruleset`: ESLint comments plugin plus Oxlint directive reporting | Oxlint JavaScript plugin host and root options  |
| Gateway/generated import restrictions | `generated-config`: registry-backed `no-restricted-imports`                 | Oxlint config factory                           |
| Syntax-only custom rules              | `local-original`                                                            | `tooling/antidrift/src/oxlint-plugin`           |
| TypeChecker-backed custom rules       | `local-original`                                                            | Reduced ESLint config and plugin                |
| Custom rule maturity and examples     | `local-original` registry                                                   | `policy/registries/rules.yaml`                  |
| Complexity, nesting, and parameters   | `ecosystem-ruleset`: Oxlint                                                 | Oxlint config                                   |
| Compiler correctness                  | `delegated-tool`: TypeScript project build                                  | `pnpm typecheck`                                |
| Tests                                 | `delegated-tool`: Vitest                                                    | `pnpm test`                                     |
| Policy generation and verification    | `local-original`                                                            | `tooling/antidrift/src/policy`                  |
| Shell guardrails                      | `local-original`: ast-grep pack                                             | `antidrift shell`                               |
| Agent lifecycle                       | `delegated-tool`: generated hooks                                           | Policy-generated hook configuration             |
| Portfolio analysis                    | `delegated-tool`: SonarQube                                                 | Sonar project and profile configuration         |

## Addition Checklist

1. Pick one source type and one enforcement owner.
2. Record the exact package, rule IDs, and local configuration surface.
3. For custom behavior, update the rule registry and real-corpus evidence.
4. Compare against maintained Oxlint, ESLint, TypeScript, React, Vitest, import, and Sonar coverage before writing custom code.
5. When ownership moves, update `docs/lint-rule-parity.md` and delete the previous enforcement in the same change.
6. Record borrowed repository paths only as provenance; name the final maintained owner.
7. Keep consumer-only tooling outside the package unless a separate policy change establishes ownership.
