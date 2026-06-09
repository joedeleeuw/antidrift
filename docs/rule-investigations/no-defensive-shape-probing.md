# no-defensive-shape-probing Investigation

## Current Rule

`antidrift/no-defensive-shape-probing` is implemented and enabled. It is `ready`, but not `stable`.

The real-corpus-backed signal is the `Object.entries(...).map` extractor branch: broad object normalization that repeatedly inspects entry values instead of using an owned schema or converter.

The rule now requires TypeScript parser services. It only reports when the `Object.entries` value binding is typed as `any`, `unknown`, or a type string containing `any`/`unknown`, and the callback body repeatedly probes object shape.

The disputed boolean-helper branch was removed from this rule. Real corpus review showed ordinary route/predicate helpers can look similar without being type laundering.

## Ecosystem Check

Adjacent ecosystem rules:

- `@typescript-eslint/no-unsafe-member-access`, `@typescript-eslint/no-unsafe-return`, and `@typescript-eslint/no-unsafe-assignment` catch many `any` leakage symptoms. A benchmark over Chaski BFF, Codebase Atlas, and Sudocode CLI checked 577 files and found 1 antidrift finding, 373 unsafe-member-access findings, 30 unsafe-return findings, and 209 unsafe-assignment findings. The Chaski drift is partially overlapped: antidrift reports the `Object.entries` callback at line 706, while upstream reports the individual `.numberValue`, `.stringValue`, and `.boolValue` member reads at lines 710-712.
- `@typescript-eslint/no-unsafe-type-assertion` catches unsafe narrowing assertions, but does not catch broad-object probing or normalizer callbacks.
- `@typescript-eslint/no-unnecessary-condition` catches impossible or redundant conditions once type information proves them unnecessary.
- `@typescript-eslint/switch-exhaustiveness-check` covers discriminated-union exhaustiveness, not broad-object normalization.
- ESLint core `guard-for-in` addresses inherited keys in `for...in`, not `Object.entries` shape probing.

No existing rule found so far covers the real-corpus-backed `Object.entries(...).map` mini-parser shape as one architectural finding with an owned converter/schema replacement. The current status is partial overlap, not net-new coverage.

## Applied Direction

The active rule is narrowed to the real-corpus-backed extractor signal. Predicate/type-guard laundering is owned by `no-underchecked-type-predicate`, which is a separate TypeChecker-backed rule for broad-input object predicates.

This is the shape it flags:

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

The important detail is the type of `value`: in the Chaski drift case, TypeScript reports it as `any` because the source map comes from generated protobuf `globalParams?: { [key: string]: any }`.

The rule does not report ordinary typed `Object.entries(...).map` transformations, schema-backed parsing, or type-predicate helpers. If TypeScript parser services are unavailable, the rule does not report.

## Remediation Applied

1. Removed the callable boolean-helper visitor from `no-defensive-shape-probing`.
2. Kept only `CallExpression` handling for `Object.entries(...).map`/`flatMap`/related transforms.
3. Added TypeChecker evidence: the entry value binding must be broad (`any`/`unknown`) before the shape-probe count matters.
4. Added external clean corpus pressure for typed entries maps in Sudocode and Codebase Atlas.
5. Reclassified the rule from `under-proven` to `ready`; it remains `stable: false`.

## Known Risks

- Narrowing drops true positives where a broad value has already been cast to a precise local type before the entries mapper.
- `checker.typeToString(...)` is a coarse fallback for detecting `any`/`unknown` inside aliases.
- Current real drift is `any`-typed and partially covered by upstream unsafe rules. A real `unknown`-typed broad-value mini-parser would better prove unique rule value.
- Stable promotion still needs a second independent real drift repository, not only clean controls.

## Clear Examples

Allowed as syntax-only violations elsewhere in the rule set:

- `as unknown as T`: the cast tunnel is the escape hatch.
- `.forEach(async () => ...)`: the async callback is not awaited by the array method.
- `useEffect(fn)`: the missing dependency array is the lifecycle bug.

Not allowed as syntax-only violations:

- A custom `x is T` predicate that might be sound or unsound depending on its body and target type.
- A domain model that might be a legitimate DTO unless the registry and TypeChecker prove it is a fork.
- An `Object.entries` normalizer over typed owned data. This rule needs the callback value type to be broad.

## Entry Conditions For Re-expansion

- A future expansion would need a distinct real repository case that is not already covered by `no-underchecked-type-predicate`.
- Stable promotion needs a second real drift repository plus no false positives in broad inventory. Prefer a real `unknown`-typed broad-value mini-parser or benchmark evidence showing findings that upstream unsafe rules do not already explain.
- Predicate/type-guard expansions stay in `no-underchecked-type-predicate`, not here.
