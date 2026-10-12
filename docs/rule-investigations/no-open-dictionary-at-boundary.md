# no-open-dictionary-at-boundary

## Intent

Keep module boundaries connected to named owner types instead of accepting or returning arbitrary dictionaries.

## Detection

AST-only. Reports `Record<string, unknown>`, `Record<string, any>`, and equivalent string index signatures inside exported function parameter/return types or exported variable annotations. Nested inline types, exported arrow/function expressions, export lists, aliases, default exports, and declaration-only functions are included. Private functions, private locals inside exported functions, type alias declarations, interfaces, classes, and inferred types are outside this rule's scope. Type-parameter constraints and defaults (`<T extends Record<string, unknown>>`) bound a caller-chosen type rather than erase one, so they do not report. Named types are not expanded. A locally declared or imported `Record` is not assumed to be the built-in utility type.

## Controls

Default-off. `allows` lists exported names; export aliases use their public names. Anonymous default declarations use `default`. An exemption for one alias does not exempt a second public export of the same binding.

```js
"antidrift/no-open-dictionary-at-boundary": ["error", { allows: ["headers"] }]
```

Use the owning type explicitly. There is no autofix because the syntax alone cannot identify the intended owner.

## Ecosystem

Restricted-type rules can ban `Record` globally but do not express this exact exported-boundary policy. `no-appeasement-erasure` requires type information and a known value erased to unknown before its contract is re-established; this rule addresses declaration surfaces independently of initializer provenance. Extending that existing rule would change its behavior and service requirements, so this remains a separate opt-in syntax rule.

## Corpus

The local Antidrift corpus runs the checked-in `fixtures/open-dictionary/allows.ts` owner-typed boundary. Its flags companion and unit cases exercise all four dictionary forms, nested annotations, export styles, internal controls, and public-name exemptions. No independently pinned external corpus evidence is claimed.

October 12 2026 precision, on 79 deduplicated TypeScript roots (35 local, 44 on sushi; vendored, generated, build, dot and fixture trees excluded). A hit is true when the open dictionary erases a shape the code knows or an owner type that exists.

| Version                         | Hits | Repositories | Top 5                                                             | Sample |
| ------------------------------- | ---- | ------------ | ----------------------------------------------------------------- | ------ |
| Before                          | 410  | 31           | LibreChat 68, executor 55, claude-code 51, sentry 50, opencode 45 | 11/20  |
| After excluding type parameters | 324  | 29           | LibreChat 63, executor 51, claude-code 48, opencode 39, paseo 22  | 6/20   |

The after run covers 78 roots (sentry did not finish; on those roots the before count is 360 in 30). The remaining false positives are decoder and validator inputs, generic record helpers, and protocol or logging bags (MCP arguments and metadata, logger context, CLI telemetry); only exact-name `allows` separates those, so the rule stays below the 70% bar.
