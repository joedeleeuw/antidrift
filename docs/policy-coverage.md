# Policy Coverage

This document keeps the original guardrail scope honest. `policy/agent-guardrails.yaml` is intentionally broader than the implemented package, so every cluster needs an explicit coverage status.

This is a ledger, not a backlog. Do not implement a rule from this table unless it also appears in the scoped roadmap or a new issue explicitly widens scope.

Status meanings:

- **Enforced**: local checks fail through ESLint, TypeScript, tests, generated hooks, or policy scripts.
- **Partial**: at least one rule in the cluster is enforced, but named gaps remain.
- **Delegated**: owned by an external gate such as Sonar or a future secret scanner.
- **Spec only**: documented policy with no deterministic enforcement yet.

| Cluster | Status | Current enforcement | Gaps |
|---|---|---|---|
| `react-state-shape` | Partial | `antidrift/no-coupled-state-setters`, `antidrift/no-status-triplet-state`, `antidrift/require-effect-deps`, `antidrift/no-raw-fetch-in-component`, `react-hooks/*` | `react/no-use-state-waterfall`, `react/no-derived-state-effect`, and `react/no-effect-fetch-waterfall` are not implemented as separate rules. |
| `type-contract-shape` | Partial | `antidrift/no-trivial-selector-wrapper`, `antidrift/no-inline-structural-type-at-use-site`, `antidrift/no-nullable-positional-tuple`, `antidrift/no-underchecked-type-predicate`, `antidrift/no-unsafe-cast-chain`, `antidrift/no-appeasement-cast`, `antidrift/no-cast-to-branded`, `antidrift/no-defensive-shape-probing`, `@joedeleeuw/antidrift/brand` | The former `no-explicit-return-type-private-helper` rule is retired as non-deterministic; `no-defensive-shape-probing` is limited to broad-value extractor evidence and must not flag ordinary predicates; `no-cast-to-branded` is under-proven until the brand kit is adopted in real corpus code; overload/recursive helper allowlists are not modeled. |
| `abstraction-and-file-shape` | Partial | `antidrift/no-obvious-comment`; Sonar is expected to cover complexity trends | One-use helper, max function/component lines, and high-touch file growth are not enforced locally. |
| `semantic-architecture-drift` | Partial | `eslint-plugin-boundaries` enforces layer import direction and private imports; `import-x/no-cycle` enforces maintained import-cycle detection | Feature scatter and high-fan-in growth are not enforced locally. |
| `side-effects-and-boundaries` | Partial | `antidrift/no-raw-fetch-in-component`; generated `no-restricted-imports` from `policy/registries/gateways.yaml` blocks direct SDK imports outside approved wrappers | Client env access is not enforced. |
| `domain-model-drift` | Partial | `antidrift/no-status-literal-in-type`, `antidrift/no-role-literal-in-type`, `antidrift/no-canonical-model-fork` for configured repo-owned model exports | Canonical model fork detection is registry-gated and only covers configured exported object models with enough shape to compare safely. |
| `generated-type-drift` | Enforced | `antidrift/no-structural-type-fork` catches structural forks of installed package exported types and configured generated-source exported types; generated import restrictions are emitted from `policy/registries/generated.yaml` when configured | No known gap for the currently declared generated-source scope. Generated-source fork detection is inert until `generatedSources` declares the owner path. |
| `authorization-control-drift` | Partial | `antidrift/require-authz-check` on configured route/action globs for Express-style `req.params`/`ctx.params` reads | tRPC procedure boundaries, boundaryless routes, and client-only authorization are not separately enforced. |
| `error-handling` | Partial | `antidrift/no-silent-catch` | Preserve-cause and fallback-to-empty rules are not implemented. |
| `test-integrity` | Partial | `no-only-tests/no-only-tests` catches focused tests | Skipped tests, conditional expects, and tests without assertions are not fully enforced. |
| `design-system` | Partial | `antidrift/no-raw-tailwind-color`, `antidrift/no-hover-translate-card` | Generic AI copy is not enforced. |
| `observability-drift` | Spec only | None | Async-boundary context and fire-and-forget tracking rules are not implemented. |
| `performance-resource-drift` | Partial | `no-await-in-loop`, `antidrift/no-async-array-method`, `antidrift/no-redundant-zod-parse` | IO-specific await-in-loop narrowing, unbounded `Promise.all`, and network timeout enforcement are not implemented. |
| `injection-and-secret-drift` | Partial | `antidrift/no-sql-string-concat`, `antidrift/no-unsafe-deserialize` using `any`/`unknown` type signals | Secret scanning is specified but not wired. |
| `agent-ops` | Enforced | Generated hooks run generated-file protection, dangerous-shell blocking, changed-file checks, and session verification | No known gap in the local hook path. |
| `quality-gate-drift` | Partial | `policy:check-changed` protects generated/config files; `policy:check-registries` validates registry-backed rule facts; `policy:check-rule-surface` validates plugin/config/test alignment; `@eslint-community/eslint-comments/require-description` and `@typescript-eslint/ban-ts-comment` protect local disables and TypeScript suppressions | CI/Sonar weakening is not fully modeled beyond protected file checks. |
| `mcp-tooling-drift` | Spec only | None | MCP server allowlist/version controls are not implemented. |
| `sonar-governance` | Delegated | `antidrift sonar` converts ESLint JSON to Sonar external issues; `sonar-project.properties` imports them | Quality gate enforcement depends on the Sonar server configuration. |
| `agent-instructions` | Partial | `antidrift check-generated` verifies generated instruction files | Vague-rule detection is not implemented. |

## Scoped Rule Work

Do not add broad policy-table rules from this document. The chosen implementation scope is maintained in `docs/roadmap.md`; anything else needs an explicit scope-widening issue.

Completed scoped hardening:

1. `antidrift/no-trivial-selector-wrapper` is structural instead of name-gated.
2. `antidrift/no-status-triplet-state` is a configurable heuristic.
3. `antidrift/no-appeasement-cast` covers plain `any`/`unknown as NamedObject`; `antidrift/no-unsafe-cast-chain` remains the narrow tunnel rule.
4. `antidrift/no-unsafe-deserialize` uses TypeScript `any`/`unknown` signals instead of request/source names.
5. `antidrift/no-nullable-positional-tuple` blocks tuple types with multiple nullable or optional slots.
6. `antidrift/no-underchecked-type-predicate` blocks broad-input object type predicates that do not check asserted fields or delegate to a validator.
7. `antidrift/no-canonical-model-fork` catches configured first-party canonical model redeclarations.
8. `antidrift/no-defensive-shape-probing`, `antidrift/no-cast-to-branded`, and the brand kit are in the active package surface, with readiness governed by `docs/real-corpus-validation.md`; import cycles are delegated to `import-x/no-cycle`.
