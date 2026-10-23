# anti-slop rules in antidrift

## Status

Removed. `no-unknown-type-aliases` moved to `@joedeleeuw/typescript-tooling` as `tooling/no-unknown-type-aliases`. `no-chained-type-assertions` (shipped as `antidrift/no-unsafe-cast-chain`) and `no-widen-then-assert` (a branch of `antidrift/no-appeasement-erasure`) are retired, because `typescript/no-unsafe-type-assertion` in typescript-tooling's type-aware tier reports their cases. The record below describes the rules as antidrift shipped them.

## Source and license

Three rule implementations and one shared helper under `tooling/antidrift/src/oxlint-plugin/anti-slop/` are adapted from `dmmulroy/anti-slop` (MIT, Copyright (c) 2026 Dillon Mulroy) at commit `6d538555cb151d4121ed51a27db81890eacf8ae9`. The license ships beside them as `anti-slop/LICENSE`.

antidrift owns these rules. Their behavior, tests and fixes are maintained here against antidrift's own evidence; upstream releases are not tracked.

## What runs

| antidrift rule                                                                               | Runtime                | Adapted from                 |
| -------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| `antidrift/no-unsafe-cast-chain`                                                             | Oxlint, off by default | `no-chained-type-assertions` |
| `antidrift/no-unknown-type-aliases`                                                          | Oxlint, error          | `no-unknown-type-aliases`    |
| `antidrift/no-appeasement-erasure` (widen-then-assert branch, beside its TypeChecker branch) | ESLint, error          | `no-widen-then-assert`       |

## Removed

- **Known-value widening.** The branch inside `antidrift/no-appeasement-erasure` reported any explicit broad annotation on a known value, with no requirement that the code later recover the discarded type. In a labelled sample of 12 current-upstream hits across BuilderIO/agent-native, cloudflare/agents, LibreChat and opencode, none was drift, and on 41 sampled cloudflare/agents files it produced 79 of the rule's 82 findings. Widen-then-assert, which requires the recovery, scored 5/5 in the same sample.
- **Eleven syntax-only rules**, retired in 0.16.0: conditional empty-object spread, module mocking, object parameters, `Reflect.apply`, `Reflect.get`, runtime `typeof`, `shape` in identifiers, `unknown` parameters, `unknown` returns, unsafe dictionary values, and safety comments on assertions. `policy/registries/rules.yaml` (`retiredRules`) records each reason and the type-checked rule that owns the concern instead. `antidrift/no-service-constructor-imports` replaces the `makeX` relative-import rule with TypeChecker module provenance. `antidrift/no-first-party-module-mock` rebuilds module mocking the same way: it resolves the mocked specifier and reports only first-party modules (`docs/rule-investigations/no-first-party-module-mock.md`).

## Verification

Oxlint plugin tests run a bad and a clean program for each rule through the real plugin entrypoint, and the packed-consumer check runs the shared presets.
