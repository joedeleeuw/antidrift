# Lint Ownership and Parity

Each rule has one enforcement owner. Runtime migration must remove the old owner instead of running equivalent rules twice.

| Surface                                                                   | Owner                                 | Configuration                                   |
| ------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| JavaScript and TypeScript correctness                                     | Oxlint native rules                   | `tooling/antidrift/src/oxlint-config/index.mjs` |
| Supported type-aware `typescript-eslint` rules                            | `oxlint-tsgolint`                     | `options.typeAware` in the Oxlint config        |
| Shared registry, suppression, and module-size governance                  | Oxlint plus the Antidrift plugin      | `tooling/antidrift/src/oxlint-config/index.mjs` |
| React, import, Vitest, Unicorn, complexity, and repository-boundary rules | Oxlint native and JavaScript plugins  | `oxlint.config.mts`                             |
| Architecture boundaries and disable-comment policy                        | Oxlint JavaScript plugins             | `tooling/antidrift/src/oxlint-config/index.mjs` |
| Syntax, scope, and local-control-flow custom rules                        | `@joedeleeuw/antidrift/oxlint-plugin` | Shared Oxlint config                            |
| Custom rules requiring TypeScript `Program` or `TypeChecker`              | Reduced ESLint pass                   | `tooling/antidrift/src/eslint-config/index.mjs` |
| Compiler diagnostics                                                      | TypeScript project build              | `pnpm typecheck`                                |
| Portfolio analysis and quality gates                                      | SonarQube                             | Sonar project configuration                     |

`oxlint-tsgolint` 7 builds its own TypeScript 7 program, so the root `tsconfig` must be TypeScript 7-compatible even while `pnpm typecheck` uses the workspace's installed TypeScript 5.9 compiler. `options.typeCheck` remains disabled until the project compiler itself moves; this migration changes lint ownership, not compiler ownership.

Generated code is excluded only when its file or directory is declared by `policy/registries/generated.yaml` under `generatedSources[*].generated`. Names such as `generated`, `_generated`, `*.gen.ts`, and `*.generated.ts` do not bypass lint on their own.

Per-rule runtime ownership, tier, severity, retirement, and promotion facts live in `policy/registries/rules.yaml`, and the runtime configs declare which rules each pass enables. `pnpm policy:check-rule-surface` fails when a custom rule is enabled by both runtimes, so this document does not restate the per-rule enablement and default-off inventory lists.

Intentional baseline removals:

- Deprecated formatting rules such as `no-multiple-empty-lines` are delegated to the formatter.
- Import and JSX sorting conventions are formatter concerns, not lint correctness.
- Legacy React class-component rules are not copied into the new config.
- Rules without a native equivalent are retained only when they express current policy; they are not kept merely for historical parity.

Oxlint JavaScript plugins do not currently receive TypeChecker data. Upstream tracks the direct type-information bridge in [oxc#19596](https://github.com/oxc-project/oxc/issues/19596) and the empty `parserServices` behavior in [oxc#19962](https://github.com/oxc-project/oxc/issues/19962); neither has a direct implementation pull request. Draft [oxc#24262](https://github.com/oxc-project/oxc/pull/24262) forwards services from explicitly configured custom parsers, but it is aimed at non-native syntax and explicitly leaves typechecking and type-aware framework linting to the [language-plugin RFC](https://github.com/oxc-project/oxc/discussions/21936). Running every ordinary TypeScript file through that cold custom-parser path would work against Oxlint's native direction and is not this repository's migration target. `tsgolint` also closed [PR #836](https://github.com/oxc-project/tsgolint/pull/836) because custom rules outside the `typescript-eslint` set are not currently accepted. If a supported typed custom-plugin bridge lands, move a custom typed rule only after behavioral parity is proven, then delete its ESLint ownership in the same change.
