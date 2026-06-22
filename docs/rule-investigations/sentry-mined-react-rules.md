# React rules ported from getsentry/sentry

Two pure-AST rules ported from `getsentry/sentry` `static/eslint/eslintPluginSentry`
(FSL-licensed; attributed in source), promoted to **active antidrift rules**:
`antidrift/no-calling-components-as-functions` and `antidrift/no-query-data-type-parameters`.

They ship **default-off** (`status: ready`, `stable: false`). The promotion basis is
getsentry/sentry's production use across a large React/TS monorepo (trusted authorship) plus
independent evidence: a clean validation in `mrp` (`eslint/react-guardrails.mjs`, 0 false
positives) and real `getQueryData`/`setQueryData` type-parameter usage across 16 files in
`chaski`. They stay opt-in until a corpus inventory quantifies the drift; both are enabled in
`mrp` today.

## `no-calling-components-as-functions`

Flag a PascalCase, locally-declared/imported React component called as a plain function
(`Widget({label})`) instead of rendered (`<Widget label={label} />`). Bypasses the reconciler
and hook rules — a frequent agent error. Pure AST, autofixable.

- Should flag: `Widget({ label: 'x' })` where `Widget` is an imported/declared component.
- Should not flag: `<Widget label="x" />`; member calls (`Schema.Struct(...)`); SCREAMING_CASE; `*Fixture`.
- value-first classification: problem-itself (correctness).

## `no-query-data-type-parameters`

Flag explicit type parameters on `queryClient.getQueryData<T>()` / `setQueryData<T>()`, which
override TanStack Query's key-based inference and mask type mismatches. Pure AST.

- Should flag: `queryClient.getQueryData<number>(['k'])`.
- Should not flag: `queryClient.getQueryData(['k'])`.
- value-first classification: symptom of overriding inference; TanStack-scoped.

## Stable promotion gate

Flip to `stable: true` / default-on only after a corpus inventory quantifies real drift
(chaski is the first source for the query rule) and records it in the rule entry's promotion block.
