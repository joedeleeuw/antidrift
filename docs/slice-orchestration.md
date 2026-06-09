# Slice Orchestration

This document turns the current antidrift batch into reviewable progress slices. It is intentionally scoped to the ESLint-only package, the hardened custom rules, the brand utility, and the control-plane checks that keep those rules honest.

Do not use this as a queue for every rule named in `policy/agent-guardrails.yaml`. Use `docs/roadmap.md` for scope, `docs/build-patterns.md` for positive construction patterns, and this file for execution order.

## Slice Gates

Each slice must clear the success gates from `docs/roadmap.md`:

1. Scope gate
2. Pattern gate
3. Signal gate
4. Real-corpus gate
5. Repo-corpus inventory gate
6. Rule surface gate
7. Self-host gate
8. Package gate, when package exports or shipped config change
9. Session gate

Real project files prove rule behavior. Reduced fixture programs and the legacy program matrix are regression aids only, not progress gates.

## Current Batch Slices

### S1: Retire Oxlint And Keep One Lint Engine

Purpose: remove the second active lint engine and keep one public lint path: ESLint plus `typescript-eslint`.

Owned files:

- `.oxlintrc.json`
- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tooling/antidrift/package.json`
- `tooling/antidrift/src/eslint-config/index.mjs`
- `tooling/antidrift/src/oxlint-config/index.mjs`
- `docs/lint-rule-parity.md`

Acceptance:

- No active `oxlint`, `.oxlintrc`, `oxlint-config`, or `jsPlugins` wiring remains.
- Former Oxlint baseline rules are either enforced by ESLint or recorded in `docs/lint-rule-parity.md`.
- `pnpm lint` runs ESLint as the only lint command.

### S2: Add Policy Control-Plane Checks

Purpose: make generated artifacts, registries, and rule surface alignment deterministic.

Owned files:

- `tooling/antidrift/src/policy/check-generated-policy-artifacts.mjs`
- `tooling/antidrift/src/policy/check-generated-policy-artifacts.test.mjs`
- `tooling/antidrift/src/policy/check-registries.mjs`
- `tooling/antidrift/src/policy/check-registries.test.mjs`
- `tooling/antidrift/src/policy/check-rule-surface.mjs`
- `tooling/antidrift/src/policy/check-rule-surface.test.mjs`
- `tooling/antidrift/src/policy/cli.mjs`
- `tooling/antidrift/src/policy/index.mjs`
- `tooling/antidrift/src/policy/verify-session.mjs`
- `policy/registries/domain.yaml`

Acceptance:

- `pnpm policy:check-generated` detects stale generated files without rewriting them.
- `pnpm policy:check-registries` validates configured registry paths and exported domain values.
- `pnpm policy:check-rule-surface` fails if a custom rule is exported, configured, or tested inconsistently.
- `pnpm policy:validate-corpus` runs the full custom-rule inventory against maintained repo code.
- Chaski and fallback external corpus checks supply promotion evidence for rule behavior.
- `pnpm policy:verify-session` includes the required policy, corpus, lint, type, and test checks.

### S3: Harden The Existing Type-Contract Rules

Purpose: close the class/object method gaps and remove the selector-wrapper name fingerprint.

Owned files:

- `tooling/antidrift/src/eslint-plugin/index.js`
- `tooling/antidrift/src/eslint-plugin/index.test.mjs`
- `docs/real-corpus-validation.md`

Acceptance:

- `no-trivial-selector-wrapper` is structural: it catches `pickItems(bag) { return bag.items; }` without relying on `getXFromY`.
- `no-trivial-selector-wrapper` visits class methods, class fields, and object methods.
- Public methods on exported classes, exported objects, and objects returned from exported factories are treated as boundaries.
- Real repo corpus passes without weakening `no-trivial-selector-wrapper`; the former private-helper return-type rule is retired because real corpus evidence showed it was not a deterministic signal.

### S4: Add Brand And Cast-Appeasement Vertical

Purpose: make branded values available and prevent agents from casting their way into trusted domain values or named contracts.

Owned files:

- `tooling/antidrift/src/brand/index.mjs`
- `tooling/antidrift/src/brand/index.d.mts`
- `tooling/antidrift/src/brand/index.test.mjs`
- `tooling/antidrift/package.json`
- `tooling/antidrift/test/consumer-monorepo.mjs`
- `docs/real-corpus-validation.md`

Acceptance:

- Consumers import `brand`, `Brand`, and `Unbrand` from `@joedeleeuw/antidrift/brand`.
- `no-appeasement-cast` rejects `any`/`unknown as NamedObject`.
- The brand utility packs and type-checks, but the former custom brand-cast rule stays retired unless real consumer adoption and non-test forgery evidence justify reopening it.
- The packed-tarball consumer integration type-checks the brand subpath.

### S5: Replace Name Heuristics With Type Or Config Signals

Purpose: keep the rules honest where structure or types can carry the signal, and make unavoidable heuristics configurable.

Owned files:

- `tooling/antidrift/src/eslint-plugin/index.js`
- `tooling/antidrift/src/eslint-plugin/index.test.mjs`
- `docs/real-corpus-validation.md`

Acceptance:

- `no-unsafe-deserialize` uses TypeScript `any`/`unknown` argument type, not `req`/`ctx` root names.
- `no-status-triplet-state` remains an explicit heuristic but its name groups are configurable.
- The repo corpus is clean under the updated rules.

### S6: Add Defensive Shape Probing And Cycle Detection

Purpose: cover two project-motivating drift patterns: local mini-parsers over broad input, and circular imports.

Owned files:

- `tooling/antidrift/src/eslint-plugin/index.js`
- `tooling/antidrift/src/eslint-plugin/index.test.mjs`
- `docs/real-corpus-validation.md`

Acceptance:

- `no-defensive-shape-probing` stays limited to deterministic broad-value extractor cases backed by real corpus evidence.
- Ordinary boolean predicates, type predicates, and schema boundaries stay valid unless the rule can prove a validation/type authority bypass.
- Import cycles are enforced by `import-x/no-cycle`; custom cycle graph traversal stays retired unless real package constraints prove an ecosystem rule cannot be used.
- Real multi-file source remains the promotion gate for cycle coverage.

Real-corpus note: Chaski backs the extractor-callback branch with `src/frontend/bff/api/services/scenarios-service.ts`; clean controls cover an explicit type predicate and a Zod normalization boundary.

### S7: Documentation And Handoff

Purpose: make the scope, gates, and operating model explicit for future agents.

Owned files:

- `README.md`
- `tooling/antidrift/README.md`
- `docs/build-patterns.md`
- `docs/feature-slice-template.md`
- `docs/handoff.md`
- `docs/policy-coverage.md`
- `docs/registries.md`
- `docs/roadmap.md`
- `docs/rule-authoring.md`
- `docs/self-hosting-risks.md`
- `docs/slice-orchestration.md`
- `docs/sonarqube.md`

Acceptance:

- Docs point future agents at the scoped work, not broad aspirational policy expansion.
- `docs/build-patterns.md` describes the positive construction path for brands and validation boundaries.
- `docs/roadmap.md` carries success slice gates, including the repo-corpus gate.

## Repo-Corpus Evidence Command Shape

For each rule slice, collect both narrow and broad evidence:

```bash
pnpm policy:validate-chaski
pnpm policy:validate-corpus
pnpm policy:validate-external-corpus # when fallback real-source evidence is part of the slice
pnpm policy:repo-corpus -- --slice <slice-name> --rules antidrift/<rule-name>
pnpm check
```

When package exports or shipped config change:

```bash
pnpm test:integration
```

Before stopping:

```bash
pnpm policy:verify-session
```

For a focused repo-corpus investigation, write the JSON evidence report:

```bash
pnpm policy:repo-corpus -- --slice <slice-name> --rules antidrift/<rule-name> --output reports/repo-corpus-<slice-name>.json
```

If a new rule flags real project code, do not immediately tune the rule around the failure. First classify the finding:

- **True drift**: fix the project code and keep the rule.
- **Boundary case**: add a real clean corpus assertion and narrow the rule.
- **Accepted heuristic noise**: keep the rule configurable or warning-level until the signal improves.

## Suggested Landing Order

1. S1 + S2: engine consolidation and control-plane checks.
2. S3: existing-rule hardening.
3. S4: brand and cast-appeasement vertical.
4. S5 + S6: remaining scoped rules.
5. S7: docs/handoff update.

The current working tree contains all slices together. If landing in commits, keep commits in the order above so each one has a clear validation story.
