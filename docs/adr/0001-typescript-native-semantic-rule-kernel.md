# TypeScript-Native Semantic Rule Kernel (`(sourceFile, checker, program)`)

Antidrift authors all TypeChecker-backed rules against a TypeScript-native Semantic Kernel (`defineTypeScriptRule` receiving `{ sourceFile, checker, program }` and `ts.SyntaxKind` listener maps) backed by five shared Semantic Primitives in `src/semantic-adapters/`, rather than authoring rules directly against `@typescript-eslint`'s ESTree AST and per-node `esTreeNodeToTSNodeMap` lookups.

## Considered Options

- **Option A: Standard `@typescript-eslint` ESTree rules.** Every rule walks ESTree nodes and maps each node back to a `ts.Node` via `parserServices.esTreeNodeToTSNodeMap.get(node)` before querying `ts.TypeChecker`.
- **Option B: Oxlint / Bun JS plugin API (`create(context)`) for all rules.** Run all custom rules as JavaScript plugins inside `oxlint` or `bun lint`.
- **Option C (Chosen): Portable ESTree plugins for syntax/scope rules + a `tsgolint`-shaped `(sourceFile, checker, program)` Semantic Kernel for TypeChecker rules.**

## Consequences

- JavaScript plugin bridges in both `oxlint` and `bun lint` do not expose `TypeChecker` (`parserServices.program` is `null` even under `--type-aware`). Pure syntax and scope rules remain in the portable ESTree plugin so a single rule definition runs natively in `oxlint`, `bun lint`, and ESLint.
- TypeChecker rules written against `(sourceFile, checker, program)` and the five Semantic Primitives avoid ESTree-to-TSNode translation overhead in ESLint today and map structurally 1:1 to `oxc-project/tsgolint`'s `RuleContext` + `RuleListeners` (`OXLINT_TSGOLINT_PATH`) for single-pass native execution tomorrow.
