# Lint Ownership and Parity

Each rule has one enforcement owner. Runtime migration must remove the old owner instead of running equivalent rules twice.

| Surface                                                      | Owner                                                                              | Configuration                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Generic TypeScript and JavaScript lint                       | `@joedeleeuw/typescript-tooling` and maintained plugins                            | `typescript-tooling/oxlint` and `typescript-tooling/eslint` |
| Supported type-aware `typescript-eslint` rules               | `oxlint-tsgolint`                                                                  | `options.typeAware` in the shared Oxlint config             |
| Registry, suppression, and module-size governance            | Oxlint plus the Antidrift plugin                                                   | `tooling/antidrift/src/oxlint-config/index.mjs`             |
| Host-path literals                                           | `antidrift/no-host-path-literal`                                                   | `antidrift-linter` native Rust rule                         |
| Gateway, generated, and React Native import policy           | Oxlint `no-restricted-imports` from consumer registries                            | Antidrift Oxlint config                                     |
| Repository React, import, Vitest, and architecture policy    | Maintained plugins, including opt-in `react-hooks-js/no-deriving-state-in-effects` | `typescript-tooling` options plus `oxlint.config.mts`       |
| Syntax, scope, and local-control-flow custom rules           | `@joedeleeuw/antidrift/oxlint-plugin`                                              | Shared Oxlint config                                        |
| Custom rules requiring TypeScript `Program` or `TypeChecker` | Reduced ESLint pass                                                                | `tooling/antidrift/src/eslint-config/index.mjs`             |
| Compiler diagnostics                                         | TypeScript project build                                                           | `pnpm typecheck`                                            |
| Portfolio analysis and quality gates                         | SonarQube                                                                          | Sonar project configuration                                 |

`oxlint-tsgolint` 7 builds its own TypeScript 7 program, so the root `tsconfig` must be TypeScript 7-compatible even while `pnpm typecheck` uses the workspace's installed TypeScript 6 compiler. `options.typeCheck` remains disabled until the project compiler itself moves; lint ownership does not change compiler ownership.

Generated code is excluded only when its file or directory is declared by `policy/registries/generated.yaml` under `generatedSources[*].generated`. Names such as `generated`, `_generated`, `*.gen.ts`, and `*.generated.ts` do not bypass lint on their own.

Runtime configs declare enablement and severity, while `retiredRules` in `policy/registries/rules.yaml` preserves published IDs and their replacements. `pnpm policy:check-rule-surface` checks plugin export/config membership and rejects a custom rule enabled by both runtimes. Behavioral tests and packed-consumer execution own evidence; no per-rule maturity or promotion list is maintained.

Intentional baseline removals:

- Deprecated formatting rules such as `no-multiple-empty-lines` are delegated to the formatter.
- Import and JSX sorting conventions are formatter concerns, not lint correctness.
- Legacy React class-component rules are not copied into the new config.
- Rules without a native equivalent are retained only when they express current policy; they are not kept merely for historical parity.

Oxlint JavaScript plugins do not currently receive TypeChecker data. Upstream tracks the direct type-information bridge in [oxc#19596](https://github.com/oxc-project/oxc/issues/19596) and the empty `parserServices` behavior in [oxc#19962](https://github.com/oxc-project/oxc/issues/19962); neither has a direct implementation pull request. Draft [oxc#24262](https://github.com/oxc-project/oxc/pull/24262) forwards services from explicitly configured custom parsers, but it is aimed at non-native syntax and explicitly leaves typechecking and type-aware framework linting to the [language-plugin RFC](https://github.com/oxc-project/oxc/discussions/21936). Running every ordinary TypeScript file through that cold custom-parser path would work against Oxlint's native direction and is not this repository's migration target. `tsgolint` also closed [PR #836](https://github.com/oxc-project/tsgolint/pull/836) because custom rules outside the `typescript-eslint` set are not currently accepted. If a supported typed custom-plugin bridge lands, move a custom typed rule only after behavioral parity is proven, then delete its ESLint ownership in the same change.
