# unknown-input-must-be-decoded

Decode declared unknown input before a type assertion gives it another type.

The rule checks both `input as Message` and `<Message>input`. TypeScript must give the operand the type `unknown` at that expression. Its source must be a parameter or catch binding with an explicit unknown annotation, or a call whose declared return type is unknown. Async readers can declare `Promise<unknown>`. Local aliases retain that source. An inferred unknown value alone is not proof of a receiving boundary.

A function whose return annotation is a type predicate or assertion for that same parameter is the decoder. Its body stays outside this rule. Successful guards also narrow the operand before this rule checks it. Inline assertions that turn another type into unknown do not establish input provenance. The `no-appeasement-cast` rule owns those double casts when the target is a named object type.

The rule requires TypeScript parser services. Missing services produce an error. It runs in the typed ESLint pass and has no automatic fix.

The earlier assertion-only implementation regressed. It reported 19,903 hits with 0/20 precision on the fresh corpus. The earlier rule reported 4,238 hits there; its preceding October 12 sample scored 10/20. These samples use different populations. The owner now requires the provenance checks described above.

## Superseded measurement on October 13, 2026: unknown-input-must-be-decoded

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 4238 hits in 35 repositories. The new rule reports 19903 hits in 36 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 0 true, for 0% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: none. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 1 true reports out of 10. The sample does not meet the 70% precision bar. It reports internal double casts, schema metadata projections, and values checked by test assertions. An unknown operand alone does not prove an untrusted boundary. That implementation regressed and is superseded by the owner’s provenance ruling. It does not justify enabling the rule at error.

This superseded evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix/superseded-owner-fix-round`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-unknown-input-must-be-decoded.labels.tsv`. SHA256: `e7ffb3c3ef9c4486de61ba241a04e8d850bafdce85f0ffc10aa8137fe1d78b6c`. Frozen at 2026-10-13T05:07:01.008558+00:00.
- Label file: `dropped-unknown-input-must-be-decoded.labels.tsv`. SHA256: `009a17ca1199388c0fb1fdae233c201fbf2f8af71c618eb9921c6d818ac6a62b`. Frozen at 2026-10-13T05:07:17.061869+00:00.

The same typed pass reports 19903 unknown-input hits and 5752 no-appeasement-cast hits. They share 2322 exact locations in 31 repositories. Unknown-input has 17581 unique reports. No-appeasement-cast has 3430 unique reports. Combining the rules remains an open owner decision. The overlap evidence is cast-overlap.json.

## Superseded precision history

Superseded October 12, 2026 study. Before narrowing, 1,793 hits in 46 repositories scored 8/20. After the object-field and serialization changes, 1,526 hits in 45 repositories scored 10/20. Both samples fell below 70%. The later assertion-only rule regressed on the fresh corpus to 19,903 hits and 0/20, compared with 4,238 old-rule hits. The owner now requires input provenance.

The October 12 study uses 84 TypeScript roots: 40 local roots and 44 on sushi. It excludes vendor, build, generated, fixture, mock, snapshot, and analyzer input trees. The October 13 fix round uses a different fresh corpus and the shipped lint population. These studies are not interchangeable.

## Fresh measurement on October 13, 2026: unknown-input-must-be-decoded

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 4219 hits in 35 repositories. The new rule reports 1920 hits in 29 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 7 true, for 35% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: excalidraw-excalidraw, TanStack-router, triggerdotdev-trigger.dev, microsoft-playwright, payloadcms-payload, edmundhung-conform, drizzle-team-drizzle-orm. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 10. The provenance fix improves the superseded 0/20 assertion-only sample to 7/20. This remains below the owner’s 70% bar. The registry marks the rule false-positive-prone and defaultOff. The shipped configuration turns it off. Internal unknown parameters and readers still cause false reports.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-unknown-input-must-be-decoded.labels.tsv`. SHA256: `e4c8f33e61aea9c8ce9b6d9cef5ce1c64dddd05506ca342a1bf52d14ee913fb9`. Frozen at 2026-10-13T07:14:23.635424+00:00.
- Label file: `dropped-unknown-input-must-be-decoded.labels.tsv`. SHA256: `00f1d1f8db58244f24f067d9b44dc358f4620d74d3266300f94bc37ece1fea98`. Frozen at 2026-10-13T07:15:30.228598+00:00.

The same typed pass reports 1920 unknown-input hits and 12042 no-appeasement-cast hits. They share 509 exact locations in 26 repositories. Unknown-input has 1411 unique reports. No-appeasement-cast has 11533 unique reports. Combining the rules remains an open owner decision. The overlap evidence is cast-overlap.json.
