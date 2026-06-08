# antidrift Roadmap

This roadmap is limited to the lint stack, the custom rules already hardened, and the specific next rules/utilities that motivated this project. Do not use this file to add unrelated policy families.

For policy coverage status, see `docs/policy-coverage.md`. For retired-engine parity, see `docs/lint-rule-parity.md`.

## Current Scope

- Single lint engine: ESLint plus `typescript-eslint`.
- Oxlint is retired; active references should not return.
- Custom rule surface: the implemented `antidrift/*` rules exported by `tooling/antidrift/src/eslint-plugin/index.js`; `policy:check-rule-surface` keeps exports, config, and RuleTester or real-corpus coverage aligned.
- Third-party support rules: the explicit rules configured in `tooling/antidrift/src/eslint-config/index.mjs`.
- Type-contract authority is the registered rule family for the type-system work. See `docs/rule-family-type-contract-authority.md` for subsets, examples, non-goals, and research boundaries.

## Built And Hardened Scope

These rules are already in the package and are part of the core project thesis:

- `no-structural-type-fork`: type-aware fork detection, hardened through alias, optional-property, `z.infer`, and branded-type edge probing.
- `require-effect-deps`: closes the gap where `react-hooks/exhaustive-deps` does not flag a missing dependency-array argument.
- `no-redundant-zod-parse`: provenance rule for repeated parsing of the same value by the same schema.
- `no-trivial-selector-wrapper`: method/class-field coverage is closed. The former `no-explicit-return-type-private-helper` rule is retired because real corpus evidence showed private return annotations are not a deterministic smell.

## Chosen Next Scope

These were the next project scope because they are the project, not because a broad policy table mentioned them. They are implemented in the current batch:

- `no-cast-to-branded`: cannot `as` your way to a brand.
- `no-appeasement-cast`: generalize `no-unsafe-cast-chain` to plain `as T` appeasement casts.
- `no-trivial-selector-wrapper` structural rewrite: no `getXFromY` name fingerprint.
- `no-status-triplet-state`: kept as an honest configurable heuristic.
- `no-unsafe-deserialize`: use an `any`/`unknown` type signal instead of a `req`/`ctx` name fingerprint.
- `no-defensive-shape-probing`: provisional only where real corpus evidence shows deterministic broad-value mini-parsing; do not expand to general boolean predicates.
- `no-nullable-positional-tuple`: block tuple types with multiple nullable or optional slots, such as `[Date | null, Date | null]`.
- `no-underchecked-type-predicate`: block broad-input type predicates that claim object contracts without checking asserted fields or delegating to a validator.
- `no-canonical-model-fork`: registry-backed structural detection for first-party canonical model redeclarations.
- Brand kit: `Brand<T, Name>` plus `brand() -> { make, safe, is }`.
- `import-x/no-cycle`: circular-dependency detection through maintained ecosystem import-graph coverage.

## Work Order

### 1. Keep The Pulled Rule Set Intentional

The shareable config should only import plugins that enable rules. If a plugin is present but contributes no active rule, remove it.

Completed no-regret cleanup:

- Removed `eslint-plugin-jsx-a11y`; it was imported and shipped without enabling any `jsx-a11y/*` rule.

### 2. Harden Existing Custom Rules

Completed in this batch:

- `no-trivial-selector-wrapper`: replace the `get|select|extract...From...` name gate with structural detection of a wrapper that returns a member access rooted in one of its own parameters. **Implemented in this batch.**
- `no-status-triplet-state`: configurable data/loading/error name groups.
- `no-unsafe-cast-chain`: kept as the narrow cast-tunnel rule; `no-appeasement-cast` covers plain `any`/`unknown as NamedObject`.
- `no-unsafe-deserialize`: type-aware `any`/`unknown` argument signal, not request-root names.
- `no-defensive-shape-probing`: limited to real-corpus-backed broad-value extractor patterns; predicate helpers remain review-first until the rule can prove a validation/type authority bypass.
- `no-nullable-positional-tuple`: narrow deterministic syntax rule for multi-slot nullable tuples; ordinary non-null tuples and hook-style tuples with one nullable value slot stay clean.
- `no-underchecked-type-predicate`: TypeChecker-backed v1 for broad-input object predicates; discriminant guards over typed unions and schema delegation stay clean.
- `no-canonical-model-fork`: TypeChecker-backed v1 for configured first-party model owners; real Chaski report-model forks flag while the owner and a different weekly digest report model stay clean.
- `no-cycle`: retired custom relative graph traversal in favor of `import-x/no-cycle`.
- Brand kit and `no-cast-to-branded`: branded values must cross the brand validation boundary.

### 3. Preserve The Rule Control Plane

These checks support existing rules; they are not new product scope.

- `policy:check-rule-surface`: custom rules must stay exported, configured, and covered by `RuleTester`.
- `policy:check-registries`: registry-backed rule facts must point at real owners/wrappers and match exported domain literals where configured.
- `policy:check-generated`: generated agent files must match the policy source without mutating the working tree during the check.

### 4. Stop

After this batch is validated and landed, stop and reassess. Do not use this roadmap to fill every aspirational rule listed in `policy/agent-guardrails.yaml`.

## Follow-Up Research Queue

These are not current implementation slices. Each one needs an ecosystem check, a real-corpus drift file, and a clean control before it can move into the work order.

- **Discriminated-union coverage**: prefer existing type-aware ecosystem rules before custom work. `@typescript-eslint/switch-exhaustiveness-check` covers exhaustive `switch` handling over literal unions/enums, and `@typescript-eslint/no-unnecessary-condition` can catch impossible or redundant narrowing conditions. Only add custom behavior if real code shows a gap those rules cannot express.
- **Parse-at-edge and repeated validation**: keep `no-redundant-zod-parse` as the current provenance rule for repeated parsing of the same value by the same schema. Follow up on ecosystem options for Zod parse discipline, but do not replace the provenance rule with a generic `parse`/`safeParse` style rule unless real corpus evidence shows the existing rule misses the original service-to-router reparse failure mode.
- **Same-schema state recertification**: keep `no-same-schema-recertification` as research, leaning drop. Use `pnpm policy:inventory-schema-roundtrip` to classify real `Schema.parse({ ...typedState })` anchors. Codebase Atlas currently splits the key file into `markExplorationTileUnderstood` (`owned-only`, exported boundary) and `moveTo` (`cross-source`, exported boundary), which is still not enough for a blocking rule.
- **Thin typed factory wrappers**: keep `no-thin-typed-factory-wrapper` as research, leaning drop. The only safe signal is exact-forward TypeChecker symbol identity, and the broader typed-constructor Codebase Atlas anchors are now classified clean.

## Success Slice Gates

Each future progress slice must clear these gates before it is considered done:

1. **Scope gate**: the slice maps to the built/hardened scope or chosen next scope above. If it comes only from broad policy table language, stop and reshape it first.
2. **Pattern gate**: the desired construction path is documented or already present in `docs/build-patterns.md`. A rule should point to a better way to build, not only say no.
3. **Signal gate**: the slice declares its strongest required signal: TypeChecker, registry facts, scope/binding, deterministic AST shape, or import graph. If it relies on AST shape as a proxy for intent, stop.
4. **Real-corpus gate**: assert at least one real drift path and one real clean path for the changed rule, preferably in Chaski. If Chaski has only clean controls, use a narrowly accepted fallback repo and document the fallback in `docs/real-corpus-validation.md`.
5. **Inventory gate**: run `pnpm policy:validate-corpus` for the full custom-rule inventory, and run the changed rules against the real repository corpus (`apps`, `packages`, and `tooling`) with `pnpm policy:repo-corpus -- --slice <slice-name> --rules antidrift/<rule-name>`.
6. **Rule surface gate**: any custom rule is exported, configured, and covered by RuleTester or a real corpus case; `pnpm policy:check-rule-surface` must pass.
7. **Self-host gate**: `pnpm check` must pass against this repository. If a rule flags antidrift itself, either fix the repo pattern or narrow the rule with real corpus evidence.
8. **Package gate**: when exports, package shape, or shipped config change, `pnpm test:integration` must pass against the packed tarball consumer.
9. **Session gate**: `pnpm policy:verify-session` is the final local stop condition.

Real project files are the primary assertion surface. Reduced fixture programs and inline RuleTester strings are regression aids only; they are not completion evidence for rule behavior.

Subagents should be assigned against these gates: one agent can implement a narrow slice, another can audit signal choice, and another can review real-corpus false positives. Do not split agents across the same rule file unless their write sets are disjoint or the parent agent owns final integration.

## Carry-Forward Principles

- Work from the built/hardened rules and chosen next scope, not aspirational cluster names.
- Prefer TypeChecker, registry, and scope signals over AST shape. Use AST shape only when the syntax is itself the violation.
- Keep hooks for lifecycle/tool safety, policy scripts for control-plane integrity, and ESLint rules for source-code semantics.
- Every nontrivial custom-rule change needs real-corpus drift and clean evidence before promotion.
