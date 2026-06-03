# Self-Hosting Risks

This repo lints the package that defines the lint rules. That is useful only if self-hosting stays boring: rules are promoted by real-corpus evidence, policy facts are validated by scripts, and hooks enforce lifecycle safety.

## Stack-Ranked Failure Modes

| Rank | Failure mode | How it goes wrong | Current control | Next remediation |
|---|---|---|---|---|
| 1 | Registry rot | A rule reads stale gateway, domain, boundary, or generated-type facts and silently enforces the wrong project shape. | `pnpm policy:check-registries` validates registry shape and exact owner/wrapper paths. | Add rule-specific registry tests whenever a new registry-backed rule is introduced. |
| 2 | Rule surface drift | A custom rule is exported but not configured, configured under the wrong name, or never covered by `RuleTester`. | `pnpm policy:check-rule-surface` compares plugin exports, active config, and RuleTester coverage. | Keep rule tests close to `tooling/antidrift/src/eslint-plugin`. |
| 3 | Aspirational policy drift | `policy/agent-guardrails.yaml` names a rule family that is not actually enforced, and agents treat it as active. | `docs/policy-coverage.md` marks clusters as enforced, partial, delegated, or spec-only. | Move to rule-level status when a cluster has more than one active gap causing confusion. |
| 4 | Corpus theater | A reduced example is treated as proof even though no real source file exhibits the drift or clean boundary. | `docs/real-corpus-validation.md` records ready, under-proven, over-broad, and false-positive-prone states. | Promote a rule only after `policy:validate-corpus`, `policy:validate-chaski`, or a documented fallback real corpus proves behavior. |
| 5 | Self-appeasement | Rule source gets contorted to satisfy its own rules instead of proving the rule is correct. | Rule validity comes from real-corpus drift and clean evidence, not from passing self-lint. | Keep regression tests local, but require source-code evidence before calling a nontrivial rule ready. |
| 6 | Hook creep | Hooks start duplicating semantic lint rules, creating two enforcement paths and inconsistent failure messages. | Hooks are limited to generated-file protection, dangerous shell blocking, changed-file checks, and stop/session verification. | Put code semantics in ESLint unless the check needs tool-call context. |
| 7 | Retired-engine creep | A second lint engine returns through scripts, exports, or generated artifacts. | ESLint is the only active lint path; `docs/lint-rule-parity.md` is the historical ledger. | Treat new engines as `[policy-change]` work with a rule-by-rule migration plan. |

## Hook vs Rule vs Doc

Use **ESLint rules** when the violation is visible in AST, scope, imports, or TypeScript checker state. Examples: structural type forks, inline status literals, SDK direct imports, unsafe cast chains, raw fetch in components.

Use **policy scripts** when the problem is about repository control-plane integrity rather than source-code semantics. Examples: generated artifact drift, registry path validity, rule export/config/test surface consistency.

Use **hooks** when the check depends on agent tool lifecycle or needs to stop unsafe actions before source code exists. Examples: blocking edits to generated instruction files, blocking destructive shell commands, forcing session verification before stop.

Use **docs/templates** when the desired behavior is a construction pattern that cannot be inferred reliably from one file. Examples: choosing the owner for a new domain concept, deciding whether a schema is a wire contract or domain model, planning a feature slice.

## Subagent Slices

Use subagents for bounded read-only audits or disjoint implementation slices:

1. Engine trace audit: confirm no active retired-engine paths remain.
2. Domain concept audit: compare `packages/domain`, contracts, registries, and docs for duplicated concepts.
3. API/depth audit: inspect package exports, CLI modules, config factory, and checks for pass-through layers and avoidable repeated work.
4. Rule implementation slice: one custom rule or one policy script per worker, with a disjoint write set.

Do not use subagents to edit the same rule file concurrently unless each worker owns a clearly separated section and the parent agent performs the integration.
