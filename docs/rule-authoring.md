# Rule Authoring Guide

Every rule in `@joedeleeuw/antidrift` is a standard host-agnostic `{ meta, create(context) }` module under `src/oxlint-plugin/` that executes identically in both **Oxlint** (`jsPlugins`) and **ESLint v9/v10** (`plugins: { antidrift }`) with zero runtime dependencies.

## Rule Contract

- Export `{ meta, create(context) }` (never `createOnce(context)` alone and never `@oxlint/plugins` runtime wrappers).
- Rely on `ESTree` (including `.parent` links), `context.sourceCode`, and `context.sourceCode.getScope(node)` (`ScopeManager` lexical bindings and references).
- Scope rules with `isRuleFile(context)` and `scopeProperties` from `src/oxlint-plugin/shared/rule-scope.js`.
- Keep modules cohesive and under the 500 non-blank line cap (`warnAbove: 425`).

## Division of Responsibility

- **Type-system invariants** (assignability, exhaustiveness, unsafe `any` flow, floating promises) belong to stock `oxlint --type-aware` (`tsgolint`) and `tsc`.
- **Cross-file graph invariants** (unused exports, circular dependencies, architectural layer boundaries, whole-repo clones) belong to `fallow` and `import/no-cycle`.
- **Boundary, lexical, and AST invariants** (unsafe deserialization, undecoded `unknown` boundary parameters, appeasement casts, structural type forks in a module, React render/state hygiene, test-oracle independence, and directive smells) live in `src/oxlint-plugin/`.
