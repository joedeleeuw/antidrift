# No Silent Empty Detection Fallback

## Scope

`antidrift/no-silent-empty-detection-fallback` catches empty-string sentinels in identity, host, probe, lookup, and detection helpers. The motivating failure was a trace identity helper that returned `""` when platform UUID detection failed, allowing callers to treat a missing device id like a real value.

The rule is AST-only and name-scoped. It reports empty-string `return` values, `|| ""`, `?? ""`, and conditional branches returning `""` inside detection-style helpers.

## Evidence

- Historical drift shape: a macOS platform UUID helper returned `""` for non-Darwin, regex miss, and catch failure paths.
- Real clean corpus: dotfiles `config/opencode/plugins/sleepernet-agent-traces.js` now throws when no stable device id can be detected and is validated through the dotfiles external corpus case.

## Status

The rule is ready but default-off. Empty strings are valid in ordinary formatting helpers, so stable/default-on promotion needs more real drift examples and false-positive measurement.
