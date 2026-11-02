# Host-Agnostic ESTree and ScopeManager Plugin Architecture

`@joedeleeuw/antidrift` ships as a single, zero-dependency JavaScript package rooted at `src/` whose rules execute natively in both Oxlint (`jsPlugins`) and ESLint 9+ (`plugins`) without a custom compiler fork, N-API addon, or platform binary matrix.

## Considered Options

- **Option A: Forked Rust compiler + N-API / stdio engine (`tsrs` + `tsrslint` + 7 platform binaries).** Embed a pinned Rust port of TypeScript 7 (`tsrs`) and ship platform-specific N-API addons and CLI binaries alongside the JS package.
- **Option B: Separate Oxlint and ESLint plugin implementations.** Maintain `@oxlint/plugins` `createOnce` rules for Oxlint and separate ESLint rules for ESLint.
- **Option C (Chosen): Single host-agnostic ESTree + `ScopeManager` rule contract (`{ meta, create(context) }`) in a zero-dependency package, delegating type-graph checks to `oxlint --type-aware` (`tsgolint`), Fallow, Clippy, and `ast-grep`.**

## Consequences

- Every rule in `src/oxlint-plugin/` uses standard `ESTree` nodes, `context.sourceCode`, and `context.sourceCode.getScope(node)` (`ScopeManager`), so the exact same rule object runs in Oxlint (`jsPlugins: ["@joedeleeuw/antidrift"]`) and ESLint (`plugins: { antidrift }`) with zero runtime dependencies.
- Whole-program dead code, unused component props, circular dependencies, and duplication are delegated to Fallow; standard type-aware checks are delegated to `oxlint --type-aware` (`oxlint-tsgolint`); Rust static checks live in `clippy.toml` and declarative `ast-grep` YAML rules.
