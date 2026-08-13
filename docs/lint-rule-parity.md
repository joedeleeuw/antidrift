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

The reduced ESLint pass currently enables:

- `antidrift/no-contract-appeasement-projection`
- `antidrift/react-max-component-props`
- `antidrift/no-unsafe-deserialize`
- `antidrift/no-appeasement-cast`
- `antidrift/no-canonical-model-fork`
- `antidrift/no-nullable-positional-tuple`
- `antidrift/no-structural-type-fork`

The structural and canonical rules receive generated, accepted package-owner, and domain-owner facts from the consumer policy registries. The Oxlint plugin enables `antidrift/require-effect-deps` and `antidrift/no-static-property-loop`. It also preserves these rules as default-off inventory:

- `antidrift/no-async-array-method`
- `antidrift/no-calling-components-as-functions`
- `antidrift/no-duplicated-conditional-classnames`
- `antidrift/no-duplicated-object-field-blocks`
- `antidrift/no-handrolled-resource-lifecycle-cells`
- `antidrift/no-inline-structural-type-at-use-site`
- `antidrift/no-nonindependent-test-oracle`
- `antidrift/no-query-data-type-parameters`
- `antidrift/no-raw-fetch-in-component`
- `antidrift/no-redundant-zod-parse`
- `antidrift/no-shattered-ingested-entity-state`
- `antidrift/no-silent-empty-detection-fallback`
- `antidrift/no-status-literal-in-type`
- `antidrift/require-authz-check`

The ESLint pass preserves these TypeChecker-dependent or hybrid rules as default-off inventory:

- `antidrift/no-defensive-shape-probing`
- `antidrift/no-sql-string-concat`
- `antidrift/no-underchecked-type-predicate`

`antidrift/no-redundant-zod-parse` moved from the ESLint pass to the Oxlint plugin on 2026-08-13. It is a whole-rule migration, not a dual registration: the ESLint plugin no longer exports it, so `repo-corpus` — which derives its rule universe from the ESLint plugin's exports — no longer counts it, which is correct because ESLint no longer runs it. The detection mechanism changed with the tier, from TypeChecker symbol identity to canonical-path provenance over scope bindings, so it re-enters as default-off inventory.

No rule above is retired by this migration. Retirement requires a separate evidence review and an explicit registry decision. The ESLint and Oxlint plugin exports are disjoint: there is no compatibility export of Oxlint-owned rules through ESLint. `policy:check-rule-surface` fails if a custom rule is exported or enabled by both runtimes.

Intentional baseline removals:

- Deprecated formatting rules such as `no-multiple-empty-lines` are delegated to the formatter.
- Import and JSX sorting conventions are formatter concerns, not lint correctness.
- Legacy React class-component rules are not copied into the new config.
- Rules without a native equivalent are retained only when they express current policy; they are not kept merely for historical parity.

Oxlint JavaScript plugins do not currently receive TypeChecker data. Upstream tracks the direct type-information bridge in [oxc#19596](https://github.com/oxc-project/oxc/issues/19596) and the empty `parserServices` behavior in [oxc#19962](https://github.com/oxc-project/oxc/issues/19962); neither has a direct implementation pull request. Draft [oxc#24262](https://github.com/oxc-project/oxc/pull/24262) forwards services from explicitly configured custom parsers, but it is aimed at non-native syntax and explicitly leaves typechecking and type-aware framework linting to the [language-plugin RFC](https://github.com/oxc-project/oxc/discussions/21936). Running every ordinary TypeScript file through that cold custom-parser path would work against Oxlint's native direction and is not this repository's migration target. `tsgolint` also closed [PR #836](https://github.com/oxc-project/tsgolint/pull/836) because custom rules outside the `typescript-eslint` set are not currently accepted. If a supported typed custom-plugin bridge lands, move a custom typed rule only after behavioral parity is proven, then delete its ESLint ownership in the same change.
