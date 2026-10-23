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

The broader set comes from the same runtime-schema API family reviewed during a private app's test cleanup. Type-only imports are clean.

### `antidrift/no-validator-output-oracle`

An expected value must not come from the application output or the input passed to its validator. A different variable name does not establish independence.

The rule follows expected values through local bindings, assignments, destructuring, property reads, calls, and local function bodies. It compares their dependencies with those of the validated arguments. The schema receiver and schema-builder arguments do not seed that comparison. Shared bindings and expressions prevent the independent-value exemption. A separate literal also fails when it equals an input passed to the application call. Object property order does not make a literal independent.

A parse of application output stays allowed when the assertion compares it with an independent expected value. Validator acceptance fields, missing expected values, and validator-only throw checks still report. Validator methods need a known schema receiver.

Imported helper bodies and writes made inside external functions remain outside scope. The rule does not prove independence across those boundaries.

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

The motivating real corpus was the private app's test cleanup and its accompanying high-effort advisory review: direct schema assertions, test-authored schema readers, safe-parse outcome checks, issue projections, and validator-only throw tests were removed. The app's current checkout is intentionally clean after that removal, so no stale external-corpus drift path is registered. Reduced Oxlint programs lock the accepted syntax boundaries but are not promotion evidence.

The validator-output rule is enabled and remains unstable. Its fresh measurement must judge independent application behavior. A different binding name or a separate copy of the input does not supply that evidence. The other two rules keep their own registry settings.

## Superseded measurement on October 13, 2026: no-validator-output-oracle

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 3215 hits in 18 repositories. The new rule reports 3253 hits in 18 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 19 true, for 95% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: anatine-zod-plugins, vercel-ai, drizzle-team-drizzle-orm, payloadcms-payload, ts-rest-ts-rest, triggerdotdev-trigger.dev, calcom-cal.com, formbricks-formbricks, pingdotgg-t3code, inngest-inngest-js, Effect-TS-effect, twentyhq-twenty, edmundhung-conform, better-auth-better-auth, dmmulroy-herdr-ts-sdk, mastra-ai-mastra, documenso-documenso. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 10 true reports out of 10. The false report occurs in a real database-backed request test with an independently arranged page ID. Dropped-hit labels expose missed contract tests and factory or constructor echoes. Imported function bodies remain outside the local analysis. Direct literal inputs and literal act arguments are compared by value. Schema receivers and schema-builder arguments do not seed validated input dependencies.

This superseded evidence is kept as local evidence outside the repository. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-validator-output-oracle.labels.tsv`. SHA256: `e6ff4d3789ffb334db711e56e418dbd89ee7e99627b5a85fe4b2a68ba70e48a0`. Frozen at 2026-10-13T05:07:01.008990+00:00.
- Label file: `dropped-no-validator-output-oracle.labels.tsv`. SHA256: `f85df55980285c478ffecafba1ec3e53b3ec5f64ae0b250b4251da96bca48cbe`. Frozen at 2026-10-13T05:07:17.062079+00:00.

## Fresh measurement on October 13, 2026: no-validator-output-oracle

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 3215 hits in 18 repositories. The new rule reports 3253 hits in 18 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 20 true, for 100% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: inngest-inngest-js, Effect-TS-effect, payloadcms-payload, better-auth-better-auth, triggerdotdev-trigger.dev, pingdotgg-t3code, edmundhung-conform, dmmulroy-herdr-ts-sdk, mastra-ai-mastra, formbricks-formbricks, vercel-ai, twentyhq-twenty, drizzle-team-drizzle-orm, calcom-cal.com, ts-rest-ts-rest, documenso-documenso, openstatusHQ-openstatus. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 10 true reports out of 10. The rule follows local dependencies and compares literal input echoes. Only validated arguments count as input. Schema receivers and builder arguments do not. Imported helper bodies remain outside the analysis. Absence-only assertions, injected fakes, property tests, and contract tests are violations under the owner ruling. All ten sampled dropped reports remain violations. This exposes incomplete analysis of builder calls and transformed contract expectations.

Evidence is kept as local evidence outside the repository. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-validator-output-oracle.labels.tsv`. SHA256: `6fb1a039eb42426af74985fa7b1539f6b0722a5bde430572244da51c931b6fa0`. Frozen at 2026-10-13T07:14:23.636138+00:00.
- Label file: `dropped-no-validator-output-oracle.labels.tsv`. SHA256: `0b0572fe3c39c923a90fb93c0861f978bb49a635752e4135dea47ef16630c7a9`. Frozen at 2026-10-13T07:15:30.228863+00:00.
