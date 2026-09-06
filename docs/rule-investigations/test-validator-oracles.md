# Test Validator Oracle Guardrails

## Complaint and failure mode

A test can look precise while proving only that a runtime-schema library implements the schema declared in the same test or production module. Two deterministic source patterns create this failure:

1. a test imports a runtime-schema library as a value and can therefore author a second schema, reader, or sanitizer;
2. an assertion traces directly to validator output, including success/error objects, projected fields, built-in projections, or validator-only throw callbacks;
3. one test arranges a mock and then asserts an object or array shape obtained from `response.json()`.

These tests are not independent evidence for application behavior. They often survive application regressions and fail during harmless schema refactors. Object-shape matchers are review signals, not behavior evidence. Invoking a thin route around a mocked backend does not make a response-body oracle independent: the mock still supplies the object being asserted.

## Preferred construction

Tests should build plain typed fixtures and assert observable application behavior. Type-only imports remain valid. JSON, YAML, path, URL, and similar document/path parsing are not runtime-schema validation and remain outside this rule family. Replacing `expect(schema.parse(body))` with direct body equality does not rehabilitate a test when the expected body shape is still its only oracle. Object-shape checks are candidates for deleting the entire test block, not for changing the matcher or removing `schema.parse`.

A parsed fixture may be passed into a substantive application call and the application result asserted. The syntax rules do not inspect helper bodies or guess that a wrapper is thin. If provenance is hidden behind another function, cross-file semantic proof is required and the rules stay silent.

Decision rule:

- If the test would still pass when the route or client merely returns the mock's object, delete the block.
- If the test also proves an independently owned state transition, side effect, request, filesystem artifact, process result, or network effect, retain that behavior assertion and remove the response-body shape oracle.

Bad oracles include all of these forms:

```ts
expect(UserSchema.parse(await response.json())).toEqual(expectedBody);
expect(await response.json()).toEqual({ id: "user_1" });
expect(body).toMatchObject({ id: "user_1" });
expect(body).toEqual(expect.objectContaining({ id: "user_1" }));
```

A retained test must prove an effect not supplied by the mock:

```ts
backend.mockResolvedValue({ id: "user_1" });
await GET(request);
expect(backend).toHaveBeenCalledWith(request);
expect(await persistedUser("user_1")).toMatchObject({ state: "active" });
```

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

### `antidrift/no-mocked-response-body-oracle`

The assertion is the policy surface. Inside one test/spec callback, the rule requires a supported mock arrangement (`mockResolvedValue`, `mockResolvedValueOnce`, `mockReturnValue`, `mockReturnValueOnce`, `mockImplementation`, or `mockImplementationOnce`) and a `toEqual`, `toStrictEqual`, or `toMatchObject` assertion whose subject traces to `response.json()`. The expected static object or array must also match the arranged value (or a nested arranged value); local aliases and `expect.objectContaining`/`expect.arrayContaining` subsets are recognized. Transformed responses, canonical error mappings, and additive-field stripping stay clean.

The trace follows only local const aliases and transparent await/member chains. It does not infer helper behavior, mock-to-route wiring, function names, project names, or cross-file ownership. Status, headers, requests, call counts, scalar body checks, application results not derived from `.json()`, unmocked response bodies, and real filesystem/process/network artifacts stay clean.

The diagnostic deliberately recommends deletion rather than matcher substitution. A response-body object shape supplied by a mock is not behavior evidence. Keep the test only when another assertion proves an independently owned effect, and remove the shape oracle.

## Ecosystem comparison

- Oxlint/Vitest integrity rules catch focused, skipped, conditional, assertion-free, and malformed throw tests, but do not identify runtime-schema value ownership, validator output, or a mocked `response.json()` object shape as the oracle.
- Core `no-restricted-imports` can ban static package imports in configured test globs, but it does not provide one portable test-file rule covering type-only exceptions, CommonJS require, dynamic import, and validator-oracle tracing.
- `no-restricted-syntax` and structural search can match direct calls but cannot safely follow local bindings and projection chains while stopping at application calls.

The import rule therefore has partial configuration overlap; both oracle rules are net Antidrift.

## Evidence and limits

The motivating real corpus was the Murderbox cleanup and its accompanying high-effort advisory review: direct schema assertions, test-authored schema readers, safe-parse outcome checks, issue projections, and validator-only throw tests were removed. The current Murderbox checkout is intentionally clean after that removal, so no stale external-corpus drift path is registered. Reduced Oxlint programs lock the accepted syntax boundaries but are not promotion evidence.

All three rules ship default-off and unstable. Promotion requires a pinned real drift source plus clean controls for document parsers, application parser APIs, parsed fixtures passed into application behavior, type-only schema imports, unmocked responses, response metadata, scalar assertions, and independently owned effects.
