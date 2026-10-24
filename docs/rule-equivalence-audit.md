# Rule Ownership and Equivalence

A custom rule earns ownership only when a maintained tool cannot express the intended proof or policy. Compare implementations and options against real drift and clean controls, not rule names or descriptions alone.

This is the ownership policy, not a second rule catalog. Plugin configs own active enablement and severity, behavioral tests own executable evidence, and `policy/registries/rules.yaml` owns only semantic-fact contracts and published retirements. `docs/lint-rule-parity.md` records runtime ownership. `docs/real-corpus-validation.md` retains historical real-source evidence rather than a promotion gate.

## Owners

- `@joedeleeuw/typescript-tooling` owns generic TypeScript, Oxlint, ESLint, and maintained third-party rules. Its consumers receive tool-native defaults rather than Antidrift implementations of the same behavior.
- `@joedeleeuw/antidrift` owns custom semantic rules and the policy machinery that maps consumer registries to configuration. TypeChecker-backed rules remain in the reduced ESLint pass while Oxlint JavaScript plugins lack equivalent checker access.
- Consumer registries own project-specific owners, wrappers, and exceptions. Antidrift translates those facts into maintained `no-restricted-imports` and ESLint `no-restricted-syntax` enforcement rather than duplicating those detectors.

## Current integration details

- Oxlint 1.89 does not provide native `no-restricted-syntax` or `unicorn/prefer-switch`. Antidrift exposes ESLint's builtin selector rule as `governance-eslint/no-restricted-syntax` through its JavaScript-plugin adapter. `typescript-tooling` loads the real Unicorn plugin as `unicorn-js` and enables `unicorn-js/prefer-switch` with `minimumCases: 4`.
- Rika's `@rikalabs/no-property-default-fallbacks` is disabled by default. `enforceNoPropertyDefaultFallbacks: true` opts into that rule alone, not Rika's aggressive preset. `propertyDefaultAllowedFiles` declares repository-relative file patterns whose fully qualified suffixes match across checkout and config locations.
- When Rika enforcement is enabled, Antidrift disables `no-sentinel-absence-fallback` in its ESLint config. It retains selectors for no-substitution template-literal sentinels, which Rika's implementation does not detect.
- React Native restrictions remain opt-in. A consumer's `policy/registries/react-native.yaml` declares `replacementImport` and exact `allowedFiles`; without that policy, raw-touchable restrictions are inert.

## Decision procedure

1. Check the installed rule implementation, options, and actual runtime support. A catalog match is only a hypothesis.
2. Use behavioral unit tests and existing real-source evidence first. Add current corpus probes only when they answer a genuine detection uncertainty; there is no recurring promotion sweep or unit-test quota.
3. If the maintained rule proves the intended behavior, remove the custom implementation and record the replacement in `retiredRules`. Do not delete the published identifier's retirement history.
4. If overlap is partial, say which shapes and policies differ. Do not call a broader aggressive preset an equivalent replacement merely because it intersects the custom rule.
5. Keep generated configuration when the policy is a set of facts or selectors. Keep a custom semantic rule when its checker, provenance, ownership, or local control-flow proof is the distinguishing behavior.
6. Verify the actual packed consumer, including positive cases, rejected cases, default-off behavior, and configured exceptions.

Published rule identifiers remain in `policy/registries/rules.yaml` after retirement. Historical evidence documents remain evidence, not maturity metadata or a second active rule catalog.
