# no-defensive-shape-probing Investigation

## Current Rule

`antidrift/no-defensive-shape-probing` is enabled at error in the ESLint config. It is `ready`, not `stable`. A 54-repository corpus (725 `Object.entries` iteration callbacks) reports 0 findings.

The real-corpus-backed signal is the `Object.entries(...).map` extractor branch: broad object normalization that repeatedly inspects entry values instead of using an owned schema or converter.

The rule now requires TypeScript parser services. It only reports when the `Object.entries` value binding has actual TypeScript `any` or `unknown` flags, and the callback body repeatedly probes object shape.

The disputed boolean-helper branch was removed from this rule. Real corpus review showed ordinary route/predicate helpers can look similar without being type laundering.

## Ecosystem Check

Adjacent ecosystem rules:

- `@typescript-eslint/no-unsafe-member-access`, `@typescript-eslint/no-unsafe-return`, and `@typescript-eslint/no-unsafe-assignment` catch many `any` leakage symptoms. `pnpm policy:inventory-defensive-shape` now makes that comparison reproducible over two programs in a private app, another private app, Sudocode CLI/server, and Opencode console app. The current parser-clean report checks 1,680 type-aware files, records 72 `Object.entries` transform syntax candidates, finds 1 antidrift finding, 1,508 unsafe-member-access findings, 113 unsafe-return findings, and 977 unsafe-assignment findings. The private-app drift is partially overlapped: antidrift reports the `Object.entries` callback, while upstream reports unsafe access in the same file.
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

The important detail is the type of `value`: in the private-app drift case, TypeScript reports it as `any` because the source map comes from a generated protobuf field typed `{ [key: string]: any }`.

The rule does not report ordinary typed `Object.entries(...).map` transformations, schema-backed parsing, or type-predicate helpers. If TypeScript parser services are unavailable, the rule does not report.

## Sunset Sweep 2026-06-15

Run:

```bash
pnpm policy:inventory-defensive-shape
```

This is a non-blocking inventory gate. It writes `reports/defensive-shape-inventory.json` and compares `antidrift/no-defensive-shape-probing` with the adjacent TypeScript ESLint unsafe rules under parser services.

Current result:

- 1,680 type-aware files checked.
- 72 `Object.entries` transform syntax candidates.
- 0 parser errors.
- 1 `antidrift/no-defensive-shape-probing` finding.
- 1 drift repository: the private app.
- 0 additional custom findings across the private app's other program, another private app, Sudocode CLI/server, and Opencode console app.
- Same-line overlap with upstream unsafe rules: 0. Same-file upstream overlap for custom findings: 1.

Decision: block at error with the bulk-suppression baseline. It should not move toward stable promotion without a second real drift repository, preferably an `unknown`-typed broad-value mini-parser that upstream unsafe rules do not already explain.

## Earlier Corpus Sweep 2026-06-09

A syntax-first sweep over the private app, Sudocode, Opencode, Cloudflare Agents, and two other private apps found no second drift repository for this exact extractor signal. The sweep did find useful clean controls:

- A private-app module has many `!== undefined` checks on patch fields inside an `Object.entries(...).map(...)` over patches, but each patch is typed, not broad inbound data.
- Opencode `packages/console/app/src/routes/zen/util/handler.ts` recursively rewrites a provider payload template and checks arrays/objects/strings, but the value is not decoded into a domain contract and the rule stays quiet.
- API candidates with object/array guards in another private app stayed quiet under the rule.

The 2026-06-15 reproducible sweep above supersedes this ad hoc sweep as the current promotion evidence.

## Remediation Applied

1. Removed the callable boolean-helper visitor from `no-defensive-shape-probing`.
2. Kept only `CallExpression` handling for `Object.entries(...).map`/`flatMap`/related transforms.
3. Added TypeChecker evidence: the entry value binding must be broad (`any`/`unknown`) before the shape-probe count matters.
4. Added external clean corpus pressure for typed entries maps in Sudocode and another private app.
5. Kept the rule `stable: false`.
6. Added clean real-program controls for private-app typed patch application and Opencode provider payload rewriting after a broad syntax sweep found no second drift repo.

## Known Risks

- Narrowing drops true positives where a broad value has already been cast to a precise local type before the entries mapper.
- Broad-value proof is intentionally fail-closed: the rule no longer regexes `checker.typeToString(...)` for `any`/`unknown` alias text.
- Current real drift is `any`-typed and partially covered by upstream unsafe rules. A real `unknown`-typed broad-value mini-parser would better prove unique rule value.
- The 2026-06-15 sunset sweep found no second independent real drift repository, only clean controls and syntax pressure.

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
- Stable promotion needs a second real drift repository plus no false positives in broad inventory. Prefer a real `unknown`-typed broad-value mini-parser or benchmark evidence showing findings that upstream unsafe rules do not already explain. Without that evidence, keep it at error with no stable promotion; retire only if future package inventory stops producing useful discovery value.
- Predicate/type-guard expansions stay in `no-underchecked-type-predicate`, not here.
