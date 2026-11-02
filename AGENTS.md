# Repository Agent Instructions

This file is generated from `policy/agent-guardrails.yaml` and the Rust rule levels in `Cargo.toml`. Do not edit it directly.

## Required checks

Run `pnpm policy:verify-session` before pushing.

## Never

- Do not edit generated policy artifacts directly.
- Do not weaken lint/type/test/CI/Sonar/hook configuration unless the task includes `[policy-change]`.
- Do not add type escape hatches, silent catches, focused tests, or cross-layer imports.
- Do not add compatibility barrels, re-export barrels, or import-preserving barrel files.
- Do not add compatibility shims, legacy aliases, fallback wrappers, or backwards-compatible wrappers unless the task explicitly asks for a migration bridge and removal plan.

## Rule clusters

- **react-state-shape** (frontend-platform): react/no-handrolled-resource-lifecycle-cells, react/no-derived-state-effect, react/require-effect-deps, react/no-hookless-use-function, react/no-unstable-render-default-collection, react/no-query-envelope-leak, react/no-impure-render-call
- **type-contract-shape** (types-platform): ts/no-contract-appeasement-projection, ts/no-structural-type-fork, ts/no-nullable-positional-tuple, ts/no-underchecked-type-predicate
- **abstraction-and-file-shape** (architecture): arch/no-wrapping-functions, arch/max-function-lines, arch/max-component-lines, arch/max-module-lines, react/max-component-props
- **semantic-architecture-drift** (architecture): arch/no-cross-layer-import, arch/no-new-dependency-cycle
- **side-effects-and-boundaries** (platform): boundary/no-sdk-direct-use-outside-gateway, boundary/no-external-decode-in-tsx
- **domain-model-drift** (domain-platform): domain/no-inline-domain-status
- **generated-type-drift** (types-platform): gen/require-import-from-generated
- **authorization-control-drift** (security): auth/require-authz-check
- **error-handling** (reliability): errors/preserve-caught-error, errors/no-anemic-errors
- **directive-smells** (engineering-productivity): arch/no-pass-through-parameters, compat/no-compat-names, simplicity/no-nested-ternary, simplicity/no-else-if-chain, simplicity/no-branch-tree, simplicity/no-mutable-let-alias, provenance/no-host-path-literal, provenance/no-dated-comments, arch/no-hypothetical-seam, arch/no-reexport-only-module, ts/no-closed-string-parameter, simplicity/no-argument-mutation-side-effect
- **test-integrity** (quality): test/no-test-without-assertion
- **performance-resource-drift** (performance): perf/no-await-in-loop-with-io, perf/no-async-array-method, perf/require-timeout-for-network-call, perf/no-redundant-validation, perf/no-query-join-or-tree-reshape
- **injection-and-secret-drift** (security): sec/no-sql-string-concat, sec/no-unsafe-deserialize
- **agent-ops** (developer-experience): agent/block-generated-policy-edits, agent/lint-after-edit, agent/require-checks-before-push
- **quality-gate-drift** (developer-experience): policy/no-check-weakening-without-policy-task, policy/no-inline-disable-without-ticket
- **agent-instructions** (developer-experience): rules/one-source-generates-agent-files
- **rust-general** (antidrift-linter rust, levels from `[workspace.metadata.antidrift]` in Cargo.toml): rust/syntax-error, rust/max-module-lines, rust/require-workspace-lints, rust/no-orphan-module, rust/no-hollow-module, rust/no-layer-violation, rust/no-forbidden-call, rust/no-boolean-map, rust/require-strict-serde, rust/no-stringly-variant, rust/no-untyped-config-probe, rust/no-let-underscore-suppression, rust/no-ident-to-string-compare, rust/no-compat-names, rust/no-wrapping-functions, rust/no-anemic-errors, rust/no-silent-result-discard, rust/no-structural-type-fork, rust/no-value-roundtrip, rust/no-decode-to-option, rust/no-constant-return-field, rust/no-nullable-positional-tuple, rust/no-blocking-in-async, rust/no-query-join-or-tree-reshape, rust/no-contract-appeasement-projection

## Rust house style

Opt-in rules this repository turns on in `[workspace.metadata.antidrift]` (Cargo.toml). Follow them before the linter fires.

- **rust/no-inline-comment**: Put rationale and history in the commit body or field notes instead of inline comments.
- **rust/no-inline-tests**: Validate via real CLI smoke runs instead of inline unit tests; keep test = false and doctest = false on Cargo targets.
