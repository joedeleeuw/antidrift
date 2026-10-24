# Source Ledger

This ledger records the enforcement owner and provenance of each ruleset or tool. `policy/registries/rules.yaml` owns semantic-fact contracts and published retirement records; runtime ownership and migration parity live in `docs/lint-rule-parity.md`.

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

| Area                                  | Source                                                                                    | Enforcement owner                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Native JS/TS correctness              | `ecosystem-ruleset`: Oxlint Rust rules                                                    | `@joedeleeuw/typescript-tooling/oxlint`                        |
| Type-aware TypeScript lint            | `ecosystem-ruleset`: `oxlint-tsgolint` and `typescript-go`                                | `@joedeleeuw/typescript-tooling/oxlint`                        |
| TypeScript ESLint baseline            | `ecosystem-ruleset`: `@typescript-eslint/no-explicit-any`                                 | `@joedeleeuw/typescript-tooling/eslint`                        |
| React and React Compiler              | `ecosystem-ruleset`: Oxlint React plugin and official `eslint-plugin-react-hooks`         | Opt-in shared tooling plus repository `oxlint.config.mts`      |
| Import and Unicorn rules              | `ecosystem-ruleset`: Oxlint native plugins and `eslint-plugin-unicorn` under `unicorn-js` | `@joedeleeuw/typescript-tooling/oxlint`                        |
| Property-default fallback policy      | `ecosystem-ruleset`: `@rikalabs/no-property-default-fallbacks`                            | Opt-in `typescript-tooling` rule plus Antidrift overlap config |
| Host paths and template sentinels     | `generated-config`: ESLint builtin `no-restricted-syntax` selectors                       | `governance-eslint/no-restricted-syntax` JavaScript adapter    |
| Vitest integrity                      | `ecosystem-ruleset`: Oxlint Vitest plugin                                                 | Oxlint test override                                           |
| Architecture boundaries               | `ecosystem-ruleset`: `eslint-plugin-boundaries`                                           | Oxlint JavaScript plugin host                                  |
| Disable-comment policy                | `ecosystem-ruleset`: ESLint comments plugin plus Oxlint directive reporting               | Oxlint JavaScript plugin host and root options                 |
| Gateway/generated import restrictions | `generated-config`: registry-backed `no-restricted-imports`                               | Antidrift Oxlint config factory                                |
| React Native interaction ownership    | `generated-config`: optional `react-native.yaml` plus `no-restricted-imports`             | Antidrift config with consumer-declared owner files            |
| Syntax-only custom rules              | `local-original`                                                                          | `tooling/antidrift/src/oxlint-plugin`                          |
| Test validator ownership/oracles      | `local-original`                                                                          | Antidrift Oxlint plugin                                        |
| Vendored anti-slop rules              | `ecosystem-ruleset`: `dmmulroy/anti-slop@6d538555` under MIT                              | Antidrift Oxlint plugin and behavioral tests                   |
| TypeChecker-backed custom rules       | `local-original`                                                                          | Reduced ESLint config and plugin                               |
| Semantic facts and retirement records | `local-original` registry                                                                 | `policy/registries/rules.yaml`                                 |
| Complexity, nesting, and parameters   | `ecosystem-ruleset`: Oxlint                                                               | Shared tooling plus repository overrides                       |
| Compiler correctness                  | `delegated-tool`: TypeScript project build                                                | `pnpm typecheck`                                               |
| Tests                                 | `delegated-tool`: Vitest                                                                  | `pnpm test`                                                    |
| Policy generation and verification    | `local-original`                                                                          | `tooling/antidrift/src/policy`                                 |
| Shell guardrails                      | `local-original`: ast-grep pack                                                           | `antidrift shell`                                              |
| Agent lifecycle                       | `delegated-tool`: generated hooks                                                         | Policy-generated hook configuration                            |
| Portfolio analysis                    | `delegated-tool`: SonarQube                                                               | Sonar project and profile configuration                        |

## Addition Checklist

1. Pick one source type and one enforcement owner.
2. Record the exact package, rule IDs, and local configuration surface.
3. For custom behavior, add behavioral tests at the plugin/config interface. Update `rules.yaml` only for operational semantic facts or published retirements; use historical corpus evidence when it answers a real uncertainty, not as a promotion requirement.
4. Compare against maintained Oxlint, ESLint, TypeScript, React, Vitest, import, and Sonar coverage before writing custom code.
5. When ownership moves, update `docs/lint-rule-parity.md` and delete the previous enforcement in the same change.
6. Record borrowed repository paths only as provenance; name the final maintained owner.
7. Keep consumer-only tooling outside the package unless a separate policy change establishes ownership.
