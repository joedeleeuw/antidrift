# Anti-slop Rule Import

## Source

The imported rules track `dmmulroy/anti-slop` commit `6d538555cb151d4121ed51a27db81890eacf8ae9` under its MIT license. Runtime source is vendored under `tooling/antidrift/src/oxlint-plugin/anti-slop` because the upstream project is designed for vendoring and local adaptation.

## Ownership

The upstream chained-assertion rule is exposed through the existing `antidrift/no-unsafe-cast-chain` owner. The upstream known-value-widening and widen-then-assert detectors extend the existing TypeChecker-backed `antidrift/no-appeasement-erasure` owner. All other imported behaviors retain their upstream rule names under the `antidrift` namespace.

## Enforcement

Nine imported rules are blocking in the shared Oxlint configuration: conditional empty-object spread, module mocking, broad object parameters, `Reflect.apply`, `Reflect.get`, unknown returns, unknown aliases, chained assertions, and unsafe dictionary values. `antidrift/no-appeasement-erasure` is blocking in the reduced TypeChecker ESLint pass.

Five imported rules remain registered but default-off because their syntax does not prove the behavior they claim to own: runtime `typeof`, `makeX` relative imports, `shape` in identifiers, `unknown` parameters, and safety comments on assertions. They are available for explicit consumer experiments, not general enforcement.

## Verification

Oxlint plugin tests execute a bad and clean program for every imported rule through the real plugin entrypoint. Registry checks own export and configuration consistency. Live external repositories are an explicit sequential research command and are not a release or session prerequisite.
