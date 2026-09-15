# no-open-dictionary-at-boundary

## Intent

Keep module boundaries connected to named owner types instead of accepting or returning arbitrary dictionaries.

## Detection

AST-only. Reports `Record<string, unknown>`, `Record<string, any>`, and equivalent string index signatures inside exported function parameter/return types or exported variable annotations. Nested inline types, exported arrow/function expressions, export lists, aliases, default exports, and declaration-only functions are included. Private functions, private locals inside exported functions, type alias declarations, interfaces, classes, and inferred types are outside this rule's scope. Named types are not expanded. A locally declared or imported `Record` is not assumed to be the built-in utility type.

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
