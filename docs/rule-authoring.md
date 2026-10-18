# Custom Rule Authoring Guide

## Engine decision

Use Oxlint for baseline and type-aware ecosystem rules. Use its JavaScript plugin API (`tooling/antidrift/src/oxlint-plugin/`) for custom rules whose proof is available from AST, scope, or control-flow data. Author TypeChecker-backed rules in `tooling/antidrift/src/eslint-plugin/rules/` against the TypeScript-native **Semantic Kernel** (`defineTypeScriptRule` in `tooling/antidrift/src/semantic-adapters/ts-rule-kernel.mjs`, documented in `docs/adr/0001-typescript-native-semantic-rule-kernel.md`) and the five shared **Semantic Primitives** in `tooling/antidrift/src/semantic-adapters/`:

1. **Shape Identity (`shape-identity.mjs`):** Deep structural comparison of `ts.Type`s with `any`-poisoning, `error`-type undecided tracking, generic parameter/constraint matching, and property mutability/optionality checks.
2. **Symbol, Module & Package Surface Provenance (`ts-rule-kernel.mjs`, `package-entry-points.mjs`, `declared-dependencies.mjs`, `type-resolution-provenance.mjs`):** Alias resolution across imports/re-exports, package entry-point surface resolution, and external library symbol classification.
3. **Boundary & Narrowing Dataflow (`boundary-model.mjs`, `cast-narrowing-proof.mjs`, `broad-input.mjs`):** Untrusted boundary sources, interprocedural summaries, demand paths, and control-flow narrowing proofs.
4. **Program Call-Graph & Evaluation Order (`typescript-engine.mjs`, `hop-inline-verification.mjs`):** `ts.LanguageService`-backed cross-file reference discovery and expression evaluation-order stepping.
5. **Domain Provenance Graphs (`schema-provenance.mjs`, `effect-schema.mjs`, `sql-provenance.mjs`, `sql-syntax-analysis.mjs`, `react-state-graph.js`):** Cross-library schema decode provenance (Zod, Effect Schema, Valibot, TypeBox), SQL fragment/identifier/escaper provenance, and React `useState` cell/transition provenance.

Use the domain vocabulary in `GLOSSARY.md` and architectural decisions in `docs/adr/` throughout rule specs, investigations, and diagnostics. Use `docs/semantic-drift-goal.md` as the north-star requirement for new or migrated rules. A rule must recover a semantic association, authority fact, deterministic source construction, or repo/session proof surface (`docs/adr/0002-evidence-backed-provenance-over-name-heuristics.md`); every active rule in `policy/registries/rules.yaml` ships enabled by default at `"error"` (`defaultOff: false`). Use `docs/semantic-validation-matrix.md` to decide the rule's carrier, blocking threshold, and validation evidence before implementation or promotion.

Keep baseline coverage in Oxlint and track ownership, replacement, or an accepted gap in `docs/lint-rule-parity.md`.

Record source provenance in `docs/source-ledger.md` whenever you add, remove, or replace a rule, ruleset, tool, or borrowed repo reference. The ledger should say whether the source is local custom code, a maintained ecosystem rule, generated Oxlint config, a delegated tool such as Sonar, or consumer-only tooling such as Trunk.

New rules should start from `docs/build-patterns.md`: first define the simple construction pattern, then add a rule only when the violation can be detected without relying on reviewer interpretation.

Use `docs/self-hosting-risks.md` when changing the rule package itself. The short version: native and supported type-aware semantics live in Oxlint, custom TypeChecker semantics live in the Semantic Kernel (`defineTypeScriptRule`), repository control-plane checks live in policy scripts, and agent lifecycle safety lives in hooks.

Shell source guardrails are the one opt-in non-ESLint rule-pack surface. They live under `tooling/antidrift/ast-grep` and run through `antidrift shell`, so Bash syntax policy is not duplicated as an ESLint rule.

Each candidate rule is judged on its own merits. Before implementing or keeping custom code, recover the original local complaint from the current session, handoff docs, reports, or available Codex memory and translate it into a concrete failure mode. Then compare the scoped behavior against maintained ESLint, `typescript-eslint`, React, import, Vitest, Oxlint, and SonarQube ecosystem coverage. A supported equivalent is an elimination candidate: prefer pulling in the external rule or generated core config. If the custom rule is broader, narrower, or only adjacent, document that delta with real drift and clean programs. If the "why" is still unclear, do not write code; collect at least three close ecosystem/readme/practitioner references and keep the item in research.

## Signal Ladder

Use the strongest available signal. Do not start with AST shape unless the syntax itself is the violation.

1. **TypeChecker first** for type escape hatches, branded casts, structural type forks, schema provenance, service tag bypasses, unsafe deserialization, inferred/declared type relationships, and assignability.
2. **Registry/project facts** for domain vocabulary, gateway imports, generated owners, architecture boundaries, and configured authorization functions.
3. **Scope/binding** when local provenance or usage is the signal.
4. **AST shape only when deterministic by construction**: the syntax is the bad behavior, not a proxy for intent.
5. **Do not implement yet** when the rule needs human judgment and no stronger signal exists.

This means a boolean predicate such as `isWebviewRoute` is not a type escape hatch by itself. A type escape hatch needs evidence such as a `TSAsExpression`, `as unknown as`, `any`/`unknown` movement into a trusted value, branded target forging, `JSON.parse` into a trusted shape, or a `value is X`/`asserts value is X` predicate that manufactures authority without an owned validator.

## Rule categories

### Type-aware deterministic rules

These run through `defineTypeScriptRule` (`tooling/antidrift/src/semantic-adapters/ts-rule-kernel.mjs`) and require TypeScript's `Program` and `TypeChecker`:

- appeasement casts and erasures from `any`/`unknown` into named contracts
- structural type forks and restated dependency types
- cross-library redundant schema parses and validator transcoding (Zod, Effect Schema, Valibot, TypeBox)
- service constructor imports that bypass an exported Service Tag or Layer
- redundant local return type annotations restated over inferred returns
- unsafe deserialization and undecoded boundary inputs
- SQL string interpolation and concatenation with TypeChecker member/escaper provenance

Double-cast tunnels and broad unsafe assertions are covered by `@typescript-eslint/no-unsafe-type-assertion`. The former custom brand-cast rule is retired until real non-test brand forgery and adopted brand-boundary evidence justify reopening it.

The shareable `createConfig` path configures `typescript-eslint` project service for these rules. Raw plugin consumers must provide equivalent parser services. All 23 TypeChecker-backed antidrift rules fail closed via `defineTypeScriptRule` with a configuration error when they are enabled without parser services (`requireTypeServices: false` is used only for hybrid rules like `antidrift/no-sql-string-concat` that document and report their `parserServiceDeltas` branch).

### Deterministic AST or scope rules

These are valid only when the syntax or local binding is itself the violation:

- trivial selector wrappers that only return a member access rooted in their own parameter
- async callbacks in array methods that do not await callbacks
- missing effect dependency arrays
- coupled state setters
- hand-rolled resource lifecycle transitions through `no-handrolled-resource-lifecycle-cells`
- `.only` and skipped tests
- inline disables without a reason

Silent catches, import cycles, and local disable justification are intentionally not custom rule scope in the current package; use Oxlint coverage such as `no-empty`, `preserve-caught-error`, `no-console`, `import/no-cycle`, Oxlint-hosted `eslint-comments/require-description`, and native `typescript/ban-ts-comment`.

### Registry-backed rules

These need repo facts:

- domain statuses and configured canonical models
- canonical model names
- approved gateway imports
- architecture layer paths
- server boundary functions
- design tokens
- MCP servers and tool permissions

### Review-first heuristics

These should start as warnings:

- defensive shape-probing predicates or mini-parsers when the rule cannot prove a validation/type authority bypass
- feature scatter
- model similarity
- one-use helpers
- generic AI copy
- high-fan-in file growth

## Rule implementation guidance

- Keep each rule narrow and explain the desired replacement in the message.
- Use syntax-only checks only when syntax is the violation.
- Use the signal definitions in `docs/rule-status-registry.md` before choosing a rule approach. Syntax can be the violation for construction-pattern bans like `as unknown as T`, but it is not enough for ownership, trust, type authority, or domain meaning.
- Use `typescript-eslint` parser services for rules that need symbol identity, inferred types, assignability, imported declarations, or schema/type provenance.
- Use real corpus assertions first when available. For this repo, `pnpm policy:validate-chaski` is the local Chaski-backed gate for real frontend/BFF behavior. If Chaski has only clean controls for a rule, run a named external corpus with `pnpm policy:research-external-corpus -- --corpus <name>` and document that research evidence in `docs/real-corpus-validation.md`.
- Do not use reduced fixture programs as a completion gate. Real project files are the assertion surface for rule promotion.
- Add or update the rule row in `policy/registries/rules.yaml` whenever a rule is added, retired, narrowed, reclassified, or considered for stable promotion.
- Add or update the corresponding provenance row in `docs/source-ledger.md` whenever a rule, ruleset, tool, or borrowed reference changes.
- Do not mark `stable: true` in the rule registry until multiple independent real repositories replicate the behavior, with zero known false positives, zero known false negatives, no productionization concerns, and a grounded Claude Opus 4.8 advisory review.
- Track any moved, deleted, or replaced lint rule in `docs/lint-rule-parity.md` with one enforcement owner, an explicit replacement, or an accepted gap.
- Update `policyRuleReviews` in `policy/registries/rules.yaml` whenever a policy rule moves between spec-only, delegated, partial, and enforced.
- Keep plugin exports, runtime ownership, severity, and corpus coverage aligned; `pnpm policy:check-rule-surface` fails when they drift.
- Keep registry-backed options valid; `pnpm policy:check-registries` fails when owner or wrapper paths are stale.
- Emit machine-readable reports for Sonar import.
- Do not rely on prompt instructions for a rule that can be enforced mechanically.

## Naming convention

```txt
antidrift/<cluster>-<specific-smell>
```

Examples:

```txt
antidrift/no-contract-appeasement-projection
antidrift/no-handrolled-resource-lifecycle-cells
antidrift/no-raw-fetch-in-component
```
