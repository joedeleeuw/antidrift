# Test Validator Oracle Guardrails

## Complaint and failure mode

A test can look precise while proving only that a runtime-schema library implements the schema declared in the same test or production module. Two deterministic source patterns create this failure:

1. a test imports a runtime-schema library as a value and can therefore author a second schema, reader, or sanitizer;
2. an assertion traces directly to validator output, including success/error objects, projected fields, built-in projections, or validator-only throw callbacks.

These tests are not independent evidence for application behavior. They often survive application regressions and fail during harmless schema refactors. Exact checks of parsed response-body or payload shape are a common instance of this smell: invoking a thin route around a mocked backend does not make the schema-shaped oracle independent.

## Preferred construction

Tests should build plain typed fixtures and assert observable application behavior. Type-only imports remain valid. JSON, YAML, path, URL, and similar document/path parsing are not runtime-schema validation and remain outside this rule family. Replacing `expect(schema.parse(body))` with direct body equality does not rehabilitate a test when the expected body shape is still its only oracle.

A parsed fixture may be passed into a substantive application call and the application result asserted. The syntax rule does not inspect helper bodies or guess that a wrapper is thin. If the validator call is hidden behind another function, cross-file semantic proof is required and this Oxlint rule stays silent.

## Rule split

### `antidrift/no-schema-library-in-test`

The import is itself the policy surface. In test/spec files the rule rejects value imports, dynamic imports, TypeScript import-equals declarations, and unshadowed CommonJS `require` calls from:

- `zod` and subpaths;
- `valibot` and subpaths;
- `@effect/schema` and subpaths;
- `effect/Schema` and subpaths;
- `superstruct` and subpaths;
- `yup` and subpaths;
- `arktype` and subpaths;
- `@sinclair/typebox` and subpaths.

The broader set comes from the same runtime-schema API family reviewed during the Murderbox test cleanup. Type-only imports are clean.

### `antidrift/no-validator-output-oracle`

The assertion subject is the policy surface. The rule follows local const bindings, member projections, array iteration/projection methods, `Object.keys`/`values`/`entries`, `Array.from`, `JSON.stringify`, primitive conversions, and `Set`/`Map` construction back to validator calls. It also recognizes bound validator methods, imported schema-library validator functions, curried decoder calls, async validator assertions, and validator-only throw callbacks.

An outer application call terminates the trace. That is a deliberate proof boundary, not a claim that every intervening helper is substantive. The rule uses no project names, application-function name patterns, or guesses about wrapper bodies.

Broad `.parse(...)` assertion tracing excludes known JSON, YAML, path, URL, query-string, and TOML parsers. This branch remains default-off until broader corpus pressure confirms that application parsers with the same method name do not create unacceptable noise.

## Ecosystem comparison

- Oxlint/Vitest integrity rules catch focused, skipped, conditional, assertion-free, and malformed throw tests, but do not identify runtime-schema value ownership or validator output as the oracle.
- Core `no-restricted-imports` can ban static package imports in configured test globs, but it does not provide one portable test-file rule covering type-only exceptions, CommonJS require, dynamic import, and validator-oracle tracing.
- `no-restricted-syntax` and structural search can match direct calls but cannot safely follow local bindings and projection chains while stopping at application calls.

The import rule therefore has partial configuration overlap; the output-oracle rule is net Antidrift.

## Evidence and limits

The motivating real corpus was the Murderbox cleanup and its accompanying high-effort advisory review: direct schema assertions, test-authored schema readers, safe-parse outcome checks, issue projections, and validator-only throw tests were removed. The current Murderbox checkout is intentionally clean after that removal, so no stale external-corpus drift path is registered. Reduced Oxlint programs lock the accepted syntax boundaries but are not promotion evidence.

Both rules ship default-off and unstable. Promotion requires a pinned real drift source plus clean controls for document parsers, application parser APIs, parsed fixtures passed into application behavior, and type-only schema imports.
