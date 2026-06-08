# Custom Rule Authoring Guide

## Engine decision

Use ESLint plus `typescript-eslint` as the canonical host for antidrift custom rules. The original rule scope includes semantic checks that need TypeScript's `Program` and `TypeChecker`: installed package type forks, registry-backed generated-source and first-party model forks, alias/import identity, Zod provenance, inferred return types, and assignability.

Keep baseline coverage in ESLint and track any missing replacement rule in `docs/lint-rule-parity.md`.

Record source provenance in `docs/source-ledger.md` whenever you add, remove, or replace a rule, ruleset, tool, or borrowed repo reference. The ledger should say whether the source is local custom code, a maintained ecosystem rule, generated ESLint config, a delegated tool such as Sonar, or consumer-only tooling such as Trunk.

When a rule or ruleset adds a direct dependency, record its lane in `docs/dependency-lanes.md`. The lane should explain whether the dependency is a peer contract, lint engine, policy CLI helper, test-corpus package, repo control-plane tool, delegated scanner, or investigation-only package.

New rules should start from `docs/build-patterns.md`: first define the simple construction pattern, then add a rule only when the violation can be detected without relying on reviewer interpretation.

Use `docs/self-hosting-risks.md` when changing the rule package itself. The short version: code semantics live in ESLint rules, repository control-plane checks live in policy scripts, and agent lifecycle safety lives in hooks.

## Signal Ladder

Use the strongest available signal. Do not start with AST shape unless the syntax itself is the violation.

1. **TypeChecker first** for type escape hatches, branded casts, structural type forks, Zod provenance, unsafe deserialization, inferred/declared type relationships, and assignability.
2. **Registry/project facts** for domain vocabulary, gateway imports, generated owners, architecture boundaries, and configured authorization functions.
3. **Scope/binding** when local provenance or usage is the signal.
4. **AST shape only when deterministic by construction**: the syntax is the bad behavior, not a proxy for intent.
5. **Do not implement yet** when the rule needs human judgment and no stronger signal exists.

This means a boolean predicate such as `isWebviewRoute` is not a type escape hatch by itself. A type escape hatch needs evidence such as a `TSAsExpression`, `as unknown as`, `any`/`unknown` movement into a trusted value, branded target forging, `JSON.parse` into a trusted shape, or a `value is X`/`asserts value is X` predicate that manufactures authority without an owned validator.

## Rule categories

### Type-aware deterministic rules

These require `typescript-eslint` parser services and the TypeScript `Program`/`TypeChecker`:

- unsafe cast chains
- appeasement casts from `any`/`unknown` into named contracts
- casts into branded types
- structural type forks
- redundant Zod parses
- unsafe deserialization from broad values

The shareable `createConfig` path configures `typescript-eslint` project service for these rules. Raw plugin consumers must provide equivalent parser services. Fully type-aware antidrift rules fail closed with a configuration error when they are enabled without parser services, so missing type information is visible instead of silently weakening the rule.

### Deterministic AST or scope rules

These are valid only when the syntax or local binding is itself the violation:

- trivial selector wrappers that only return a member access rooted in their own parameter
- async callbacks in array methods that do not await callbacks
- missing effect dependency arrays
- silent catches
- coupled state setters
- configurable `data/loading/error` status triplets
- `.only` and skipped tests
- inline disables without a reason

Import cycles are intentionally not custom rule scope; use maintained import-graph coverage such as `import-x/no-cycle`.

### Registry-backed rules

These need repo facts:

- domain statuses and roles
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
- Use real corpus assertions first when available. For this repo, `pnpm policy:validate-chaski` is the local Chaski-backed gate for real frontend/BFF behavior. If Chaski has only clean controls for a rule, use `pnpm policy:validate-external-corpus` for a narrowly scoped fallback repo case and document that fallback in `docs/real-corpus-validation.md`.
- Do not use reduced fixture programs as a completion gate. Real project files are the assertion surface for rule promotion.
- Add or update the rule row in `policy/registries/rules.yaml` whenever a rule is added, retired, narrowed, reclassified, or considered for stable promotion.
- Add or update the corresponding provenance row in `docs/source-ledger.md` whenever a rule, ruleset, tool, or borrowed reference changes.
- Add or update `docs/dependency-lanes.md` whenever the change adds, removes, or reclassifies a direct dependency.
- Do not mark `stable: true` in the rule registry until multiple independent real repositories replicate the behavior, with zero known false positives, zero known false negatives, no productionization concerns, and a grounded Claude Opus 4.8 advisory review.
- Track any deleted or replaced lint rule in `docs/lint-rule-parity.md` with an explicit replacement or accepted gap.
- Update `docs/policy-coverage.md` whenever a policy rule moves between spec-only, delegated, partial, and enforced.
- Keep plugin exports, active config, and RuleTester coverage aligned; `pnpm policy:check-rule-surface` fails when they drift.
- Keep registry-backed options valid; `pnpm policy:check-registries` fails when owner or wrapper paths are stale.
- Emit machine-readable reports for Sonar import.
- Do not rely on prompt instructions for a rule that can be enforced mechanically.

## Naming convention

```txt
antidrift/<cluster>-<specific-smell>
```

Examples:

```txt
antidrift/no-trivial-selector-wrapper
antidrift/no-coupled-state-setters
antidrift/no-status-triplet-state
antidrift/no-raw-tailwind-color
```
