# require-convex-return-validator

Require an explicit `returns` validator on every registered Convex function.

## Intent

A registered Convex function's contract is a chain: the `returns` validator is
the runtime contract, the generated function type is derived from it, and every
consumer's inferred type flows from the generated type. Without a `returns`
validator the generated function type is inferred from the handler
implementation, so consumers inherit whatever the handler happens to return —
an implementation detail silently becomes the public contract.

```ts
// drift: no returns validator; the generated type follows the handler
export const get = query({
  args: { id: v.id("machines") },
  handler: async (ctx, args) => { ... },
});

// allowed: the validator owns the contract
export const get = query({
  args: { id: v.id("machines") },
  returns: v.union(machineResult, v.null()),
  handler: async (ctx, args) => { ... },
});
```

## Signal

TypeChecker symbol resolution, never name matching:

1. The callee is an identifier whose alias-resolved symbol is named one of
   `query`, `mutation`, `action`, `internalQuery`, `internalMutation`,
   `internalAction`.
2. Convex provenance, either of:
   - the resolved symbol's own declaration file (after the last
     `/node_modules/`) starts with `convex/` and includes `/server`; or
   - the resolved symbol's type symbol (the `QueryBuilder` / `MutationBuilder`
     / `ActionBuilder` alias) declares in that same convex server surface —
     this is the path taken for `convex/_generated/server` re-exports, the
     shape every real Convex app registers functions through.
3. The first argument is an object literal with only statically known
   properties and no `returns` key → report on the call node.

A locally declared function that merely shares the name `query` is not flagged:
neither its declaration nor its type resolves to the convex package. Aliased
imports (`import { query as publicQuery }`) still resolve and are flagged.

## Deliberate boundaries (false negatives by design)

- **Custom function builders**: registrars produced by `customFn(...)` wrap the
  base builders, so the callee's provenance no longer resolves to the convex
  server surface — silent.
- **Non-object-literal first arguments**: old-syntax `query(handler)` or
  forwarded config objects carry no statically inspectable registration object
  — silent.
- **Spread or computed properties**: an object literal with `...shared` or
  `[KEY]` members cannot be proven to lack `returns` — silent.
- **`httpAction`**: out of scope; HTTP actions have no validator concept.
- **`args` validators**: not checked here. The official
  `@convex-dev/eslint-plugin` `require-args-validator` owns that half; this
  rule is the returns half only.

## Ecosystem check (2026-08-10)

`@convex-dev/eslint-plugin` (v2.0.0 inspected in the Murderbox install) ships
`require-args-validator`, which enforces the `args` property only; no
returns-validator rule exists in the plugin, and its registrar detection is
name-matched (`CONVEX_REGISTRARS`) rather than symbol-resolved. No maintained
rule covers the returns-validator half of the registration contract.

## Corpus

- Murderbox (`apps/client/convex`): real drift control — 18 registered
  functions across `conversations.ts` (12), `littleBird.ts` (3),
  `machines.ts` (2), and `health.ts` (1), all missing `returns` validators,
  all flagged; `ctx.db.query(...)` calls correctly ignored. Measured
  2026-08-10 with the rule enabled standalone over the whole convex directory
  (18 errors, 0 false positives).
- Synthetic fixtures cover validator-covered registrations, aliased imports,
  spread/computed configs, and the same-named local function guard.
