# no-defensive-shape-probing Investigation

## Current Rule

`antidrift/no-defensive-shape-probing` is implemented and enabled, but remains `under-proven`.

The real-corpus-backed signal is the `Object.entries(...).map` extractor branch: broad object normalization that repeatedly inspects entry values instead of using an owned schema or converter.

The disputed boolean-helper branch was removed from this rule. Real corpus review showed ordinary route/predicate helpers can look similar without being type laundering.

## Ecosystem Check

Adjacent ecosystem rules:

- `@typescript-eslint/no-unsafe-type-assertion` catches unsafe narrowing assertions, but does not catch broad-object probing or normalizer callbacks.
- `@typescript-eslint/no-unnecessary-condition` catches impossible or redundant conditions once type information proves them unnecessary.
- `@typescript-eslint/switch-exhaustiveness-check` covers discriminated-union exhaustiveness, not broad-object normalization.
- ESLint core `guard-for-in` addresses inherited keys in `for...in`, not `Object.entries` shape probing.

No existing rule found so far covers the real-corpus-backed `Object.entries(...).map` mini-parser shape.

## Applied Direction

The active rule is narrowed to the real-corpus-backed extractor signal. Predicate/type-guard laundering is owned by `no-underchecked-type-predicate`, which is a separate TypeChecker-backed rule for broad-input object predicates.

This rule is not yet promoted because the remaining implementation is a syntax-pattern ban. That is acceptable only if we decide this construction is itself forbidden:

```ts
Object.entries(raw).map(([key, value]) => {
  if (value && typeof value === "object") {
    return [
      key,
      ("numberValue" in value ? value.numberValue : undefined) ??
        ("stringValue" in value ? value.stringValue : undefined) ??
        ("boolValue" in value ? value.boolValue : undefined) ??
        null,
    ];
  }
  return [key, value];
});
```

If the intended rule is "do not unpack broad or unowned data," syntax is not enough. The rule then needs TypeChecker or registry evidence that the entries source is broad, generated, external, or otherwise not an owned converter boundary.

## Remediation Applied

1. Removed the callable boolean-helper visitor from `no-defensive-shape-probing`.
2. Kept only `CallExpression` handling for `Object.entries(...).map`/`flatMap`/related transforms.
3. Updated tests and docs to reflect the narrowed scope.
4. Reclassified the rule from `false-positive-prone` to `under-proven`; it remains `stable: false`.

## Known Risks

- Narrowing may drop some true positives where an internal helper really is laundering broad input.
- A typed, owned `Object.entries(...).map` normalizer can look similar.
- Stable promotion still needs a second independent real repository and typed `Object.entries` clean controls.

## Clear Examples

Allowed as syntax-only violations:

- `as unknown as T`: the cast tunnel is the escape hatch.
- `.forEach(async () => ...)`: the async callback is not awaited by the array method.
- `useEffect(fn)`: the missing dependency array is the lifecycle bug.

Not allowed as syntax-only violations:

- A custom `x is T` predicate that might be sound or unsound depending on its body and target type.
- A domain model that might be a legitimate DTO unless the registry and TypeChecker prove it is a fork.
- An `Object.entries` normalizer that might be an owned converter unless the construction pattern itself is what the project forbids.

## Entry Conditions For Re-expansion

- A future expansion would need a distinct real repository case that is not already covered by `no-underchecked-type-predicate`.
- A real repository contains clean discriminant-only and validator-backed predicate controls.
- The separate predicate rule passes ecosystem and Claude advisory review.
