# Repository Agent Instructions

This file is generated from `policy/agent-guardrails.yaml`. Do not edit it directly.

## Required checks

Run `pnpm policy:verify-session` before pushing.

## Never

- Do not edit generated policy artifacts directly.
- Do not weaken lint/type/test/CI/Sonar/hook configuration unless the task includes `[policy-change]`.
- Do not add type escape hatches, silent catches, focused tests, or cross-layer imports.
- Do not add compatibility barrels, re-export barrels, or import-preserving barrel files.
- Do not add compatibility shims, legacy aliases, fallback wrappers, or backwards-compatible wrappers unless the task explicitly asks for a migration bridge and removal plan.

## Rule clusters

- **react-state-shape** (frontend-platform): react/no-use-state-waterfall, react/no-handrolled-resource-lifecycle-cells, react/no-derived-state-effect, react/no-effect-fetch-waterfall, react/require-effect-deps
- **type-contract-shape** (types-platform): ts/no-contract-appeasement-projection, ts/no-structural-type-fork, ts/no-nullable-positional-tuple, ts/no-underchecked-type-predicate
- **abstraction-and-file-shape** (architecture): arch/no-wrapping-functions, arch/no-one-use-helper, arch/max-function-lines, arch/max-component-lines, arch/max-module-lines, react/max-component-props, arch/no-high-touch-file-growth
- **semantic-architecture-drift** (architecture): arch/no-cross-layer-import, arch/no-deep-import, arch/no-new-dependency-cycle, arch/no-feature-scatter
- **side-effects-and-boundaries** (platform): boundary/no-sdk-direct-use-outside-gateway, boundary/no-env-access-in-client
- **domain-model-drift** (domain-platform): domain/no-inline-domain-status
- **generated-type-drift** (types-platform): gen/require-import-from-generated
- **authorization-control-drift** (security): auth/no-boundaryless-route, auth/no-client-only-authorization, auth/require-authz-check
- **error-handling** (reliability): errors/preserve-caught-error, errors/no-anemic-errors
- **directive-smells** (engineering-productivity): arch/no-pass-through-parameters, compat/no-compat-names, simplicity/no-nested-ternary, simplicity/no-else-if-chain, provenance/no-host-path-literal, provenance/no-dated-comments
- **test-integrity** (quality): test/no-only-or-skip, test/no-conditional-expect, test/no-test-without-assertion
- **design-system** (design-system): ui/no-raw-tailwind-color, ui/no-hover-translate-card, ui/no-generic-ai-copy
- **observability-drift** (reliability): obs/async-boundary-requires-context, obs/no-fire-and-forget-without-tracking
- **performance-resource-drift** (performance): perf/no-await-in-loop-with-io, perf/no-async-array-method, perf/no-unbounded-promise-all, perf/require-timeout-for-network-call, perf/no-redundant-validation
- **injection-and-secret-drift** (security): sec/no-hardcoded-secret, sec/no-sql-string-concat, sec/no-unsafe-deserialize
- **agent-ops** (developer-experience): agent/block-generated-policy-edits, agent/lint-after-edit, agent/require-checks-before-push
- **quality-gate-drift** (developer-experience): policy/no-check-weakening-without-policy-task, policy/no-inline-disable-without-ticket
- **mcp-tooling-drift** (platform-security): mcp/no-unapproved-server, mcp/pin-server-version
- **rust-self-governance** (engineering-productivity): rust/no-inline-comment, rust/max-file-lines, rust/no-orphan-module, rust/no-grab-bag-module, rust/no-hollow-module, rust/no-layer-violation, rust/no-boolean-map, rust/require-strict-serde, rust/no-stringly-variant, rust/no-untyped-config-probe, rust/no-discarded-decoded-config, rust/no-duplicate-scope-fields, rust/no-let-underscore-suppression, rust/no-ident-to-string-compare, rust/no-compat-names, rust/no-wrapping-functions, rust/no-anemic-errors, rust/no-inline-tests, rust/target-manifest-policy
- **agent-instructions** (developer-experience): rules/one-source-generates-agent-files, rules/no-vague-agent-rules
