# Dependency Lanes

Dependency lanes answer three questions for every direct dependency:

1. **Why is this package here?**
2. **How long should it live?**
3. **What source, rule, command, or policy row does it tie back to?**

This is separate from version catalogs. `pnpm-workspace.yaml` centralizes versions; dependency lanes explain ownership and lifetime.

## Lane Model

| Lane                 | Applies to                                                                                   |                                            Expected length | Required tie-back                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime-product`    | Runtime code shipped by a consumer app or package.                                           |                            Long-lived only after approval. | `architecture/approved-dependencies.yaml`, owning feature/package, and the build pattern it supports.                                            |
| `peer-contract`      | Host contracts that consumers must provide, such as ESLint, TypeScript, and parser services. |                                                Long-lived. | Public package API and install docs.                                                                                                             |
| `lint-engine`        | ESLint ecosystem plugins and configs shipped by `@joedeleeuw/antidrift`.                     |                                              Review-cycle. | `docs/source-ledger.md`, active configured rules, and `docs/lint-rule-parity.md` or `docs/rule-equivalence-audit.md` when replacing custom code. |
| `policy-cli`         | Libraries needed by antidrift policy commands.                                               | Long-lived if commands are public; otherwise review-cycle. | CLI command, policy script, or registry loader that imports it.                                                                                  |
| `test-corpus`        | Packages used only to type-check real or reduced validation programs.                        |                                        Short/review-cycle. | The test or corpus case that needs the real package type surface.                                                                                |
| `repo-control-plane` | Root-only hooks, staging, formatting, report, or session-gate tooling.                       |                                              Review-cycle. | `package.json` script, generated hook, or policy verification command.                                                                           |
| `delegated-scanner`  | Security, dependency, IaC, container, Python, Go, or other scanner tooling.                  |                                            Consumer-owned. | Consumer repo config, Sonar/CI gate, or `docs/source-ledger.md` row. Do not bundle into antidrift without `[policy-change]`.                     |
| `investigation`      | Temporary package used to evaluate an ecosystem rule or candidate.                           |                                                     Short. | Investigation doc and removal/decision follow-up. It should not remain in package dependencies after the decision.                               |

`Expected length` is not a date. It is the review posture:

- **Long-lived**: part of the public contract or runtime surface.
- **Review-cycle**: allowed while the rule/config/command it supports remains active; re-check when that surface changes.
- **Short**: should be removed or promoted quickly after the investigation or validation slice ends.
- **Consumer-owned**: belongs in consuming repos, not in the antidrift npm package.

## Current Direct Dependency Lanes

| Package or family                                                                                                                  | Lane                                  | Tie-back                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `eslint`, `typescript`, `typescript-eslint`, `@typescript-eslint/parser`                                                           | `peer-contract` plus root dev tooling | Public `createConfig` API, type-aware rules, and `tooling/antidrift/README.md`.                                    |
| `@eslint/js`                                                                                                                       | `lint-engine`                         | JavaScript recommended baseline in `tooling/antidrift/src/eslint-config/index.mjs`; source ledger ESLint base row. |
| `eslint-plugin-react`, `eslint-plugin-react-hooks`                                                                                 | `lint-engine`                         | React and React Hooks rows in `docs/source-ledger.md`; policy coverage for React state shape.                      |
| `eslint-plugin-import-x`                                                                                                           | `lint-engine`                         | Import hygiene, dependency checks, and cycle detection; replaces retired custom cycle work.                        |
| `eslint-plugin-boundaries`                                                                                                         | `lint-engine`                         | Architecture boundary checks from configured layer facts.                                                          |
| `eslint-plugin-sonarjs`                                                                                                            | `lint-engine`                         | Local broad bug/security smell lint; SonarQube remains the delegated PR/trend gate.                                |
| `eslint-plugin-unicorn`, `@eslint-community/eslint-plugin-eslint-comments`, `eslint-plugin-no-only-tests`, `@vitest/eslint-plugin` | `lint-engine`                         | Selected ecosystem hygiene, directive, and test-integrity coverage in the shared config.                           |
| `yaml`                                                                                                                             | `policy-cli`                          | Policy and registry parsing in `tooling/antidrift/src/policy/`.                                                    |
| `@microsoft/eslint-formatter-sarif`                                                                                                | `repo-control-plane`                  | `lint:sarif` and report export path.                                                                               |
| `lint-staged`, `simple-git-hooks`, `prettier`, `tsx`                                                                               | `repo-control-plane`                  | Root hook/staging/formatting/script execution surface.                                                             |
| `vitest`, `@types/node`                                                                                                            | `repo-control-plane` and test tooling | Local test and type surface.                                                                                       |
| `firebase`, `zod` in `tooling/antidrift` dev dependencies                                                                          | `test-corpus`                         | Real package type and schema-provenance programs for type-aware rule tests.                                        |
| Ruff, Black, mypy, Bandit, golangci-lint, Buf, Trivy, Checkov, Gitleaks, Trunk                                                     | `delegated-scanner`                   | Chaski and other consumer repos may use them, but antidrift should not bundle them.                                |

## Addition Rules

When adding a direct dependency:

1. Assign a lane from this document.
2. Add the version to the right pnpm catalog when it is workspace-wide.
3. Add or update the source row in `docs/source-ledger.md`.
4. For `runtime-product`, add approval in `architecture/approved-dependencies.yaml`.
5. For `lint-engine`, name the configured rules it enables and the custom rule or retired-engine coverage it replaces.
6. For `test-corpus`, name the validation case that needs the package and remove it when that case no longer needs the real dependency.
7. For `delegated-scanner`, keep it out of the antidrift package unless a future `[policy-change]` intentionally changes the package scope.

If a dependency cannot name its lane and tie-back, it should not be added.
