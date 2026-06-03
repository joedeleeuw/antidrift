# Discriminated Union Ecosystem Coverage

## Candidate

Custom discriminated-union rules were considered during type-predicate investigation.

## Ecosystem Coverage

Prefer existing type-aware `typescript-eslint` rules:

- `@typescript-eslint/switch-exhaustiveness-check` for exhaustive `switch` handling.
- `@typescript-eslint/no-unnecessary-condition` for impossible or redundant conditions.
- `@typescript-eslint/no-redundant-type-constituents` for useless union/intersection constituents.

## Decision

This is `ecosystem-covered`, not custom antidrift scope. Add custom work only if real corpus evidence shows a discriminated-union failure that these rules cannot express.

## Entry Conditions For Reopening

- A real repository demonstrates a discriminated-union bug missed by the ecosystem rules.
- The desired construction pattern is documented.
- Claude Opus 4.8 review confirms the ecosystem rules cannot cover it.
