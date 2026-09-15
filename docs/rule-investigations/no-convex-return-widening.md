# no-convex-return-widening

## Intent

Keep Convex return validators connected to their owning shape. `v.any()` leaves erase validation and widen generated return types.

## Detection

AST-only. Recognizes query, mutation, action, internalQuery, internalMutation, and internalAction builders imported from Convex's conventional `_generated/server` module or `convex/server` (including the `*Generic` exports). Renamed and namespace imports work; shadowed bindings and unrelated libraries are excluded. No repository-specific paths or function names are configured.

Only the inline `returns` property is inspected. A direct `v.any()` or an any leaf inside `v.object`, `v.array`, `v.optional`, `v.union`, or `v.record` reports once per function definition. Validator calls must resolve to the `v` import from `convex/values`, including renamed and namespace imports. Args validators and handler bodies are not examined. Static literal property access and TypeScript expression wrappers are supported. Validator aliases, custom builders, spreads containing validators, and factory-produced definitions are not expanded.

## Controls

Default-off. `allows` lists function binding names. Object properties use their property name and default exports use `default`.

```js
"antidrift/no-convex-return-widening": ["error", { allows: ["protocolPassthrough"] }]
```

Return the owning validator. No autofix can choose that validator from syntax alone.

## Ecosystem

Requiring a returns validator and prohibiting explicit TypeScript any do not detect arbitrary leaves inside an otherwise present Convex validator. This is an independent, provisional opt-in source-shape rule.

## Corpus

The local Antidrift corpus runs `fixtures/convex-return/allows.ts` using actual Convex imports and a named message validator. The flags companion contains a nested any leaf. Unit cases cover every builder, nested combinators, aliases, namespaces, exemptions, and unrelated/shadowed call controls. No independently pinned external evidence is claimed.
