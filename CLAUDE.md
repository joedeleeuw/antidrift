# Repository Agent Instructions

## Commands

- `pnpm check`: Run `tsc`, self-lint (`oxlint`), `fallow` (`dead-code` + `dupes --fail-on-issues`), and the real-runtime Oxlint + ESLint + packed-tarball smoke (`scripts/verify-smoke.mjs`).
- `pnpm typecheck`: Typecheck `oxlint.config.mts` and package `.d.ts`/`.d.mts` declarations.
- `pnpm lint`: Lint `src/`, `scripts/`, and `oxlint.config.mts` with `oxlint`.
- `pnpm fallow`: Run `fallow dead-code && fallow dupes --fail-on-issues`.
- `pnpm smoke`: Run `node scripts/verify-smoke.mjs`.

## Workspace Boundaries

- `@joedeleeuw/antidrift` is a single, flat, zero-dependency, host-agnostic ESLint + Oxlint rules package rooted at `src/`.
- Every rule in `src/oxlint-plugin/` must expose a standard `{ meta, create(context) }` contract using `ESTree`, `context.sourceCode`, and `context.sourceCode.getScope(node)` so the same plugin runs natively in both Oxlint (`jsPlugins`) and ESLint (`plugins`).
- Do not add runtime dependencies (`dependencies` in `package.json` must remain empty) or reintroduce a custom compiler/TypeChecker/N-API engine.
