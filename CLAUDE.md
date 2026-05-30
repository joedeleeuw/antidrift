# Claude Project Instructions

This file is generated from `policy/agent-guardrails.yaml`. Do not edit it directly.

Treat hooks and deterministic checks as authoritative. Fix code instead of weakening policy.

## Stop condition

Run `pnpm policy:verify-session` before stopping.

## Rule clusters

- **react-state-shape** (frontend-platform): react/no-use-state-waterfall, react/no-coupled-state-setters, react/no-status-triplet-state, react/no-derived-state-effect, react/no-effect-fetch-waterfall, react/require-effect-deps
- **type-contract-shape** (types-platform): ts/no-trivial-selector-wrapper, ts/no-mechanical-get-x-from-y, ts/no-explicit-return-type-private-helper, ts/no-inline-structural-type-at-use-site, ts/no-unsafe-cast-chain
- **abstraction-and-file-shape** (architecture): arch/no-one-use-helper, arch/no-obvious-comment, arch/max-function-lines, arch/max-component-lines, arch/no-high-touch-file-growth
- **semantic-architecture-drift** (architecture): arch/no-cross-layer-import, arch/no-deep-import, arch/no-new-dependency-cycle, arch/no-feature-scatter
- **side-effects-and-boundaries** (platform): boundary/no-raw-fetch-in-component, boundary/no-sdk-direct-use-outside-gateway, boundary/no-env-access-in-client
- **domain-model-drift** (domain-platform): domain/no-inline-domain-status, domain/no-role-literal-outside-policy, domain/no-canonical-model-fork
- **generated-type-drift** (types-platform): gen/require-import-from-generated, gen/no-structural-type-fork
- **authorization-control-drift** (security): auth/no-boundaryless-route, auth/no-client-only-authorization, auth/require-authz-check
- **error-handling** (reliability): errors/no-silent-catch, errors/preserve-caught-error, errors/no-fallback-to-empty
- **test-integrity** (quality): test/no-only-or-skip, test/no-conditional-expect, test/no-test-without-assertion
- **design-system** (design-system): ui/no-raw-tailwind-color, ui/no-hover-translate-card, ui/no-generic-ai-copy
- **observability-drift** (reliability): obs/async-boundary-requires-context, obs/no-fire-and-forget-without-tracking
- **performance-resource-drift** (performance): perf/no-await-in-loop-with-io, perf/no-async-array-method, perf/no-unbounded-promise-all, perf/require-timeout-for-network-call
- **injection-and-secret-drift** (security): sec/no-hardcoded-secret, sec/no-sql-string-concat, sec/no-unsafe-deserialize
- **agent-ops** (developer-experience): agent/block-generated-policy-edits, agent/block-destructive-shell, agent/lint-after-edit, agent/require-checks-before-stop
- **quality-gate-drift** (developer-experience): policy/no-check-weakening-without-policy-task, policy/no-inline-disable-without-ticket
- **mcp-tooling-drift** (platform-security): mcp/no-unapproved-server, mcp/pin-server-version
- **sonar-governance** (engineering-productivity): sonar/import-custom-eslint-issues, sonar/no-new-critical-issues, sonar/complexity-budget
- **agent-instructions** (developer-experience): rules/one-source-generates-agent-files, rules/no-vague-agent-rules
