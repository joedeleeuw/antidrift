# no-inline-structural-type-at-use-site

Reuse an existing object type instead of repeating its properties in a boundary parameter.

The rule checks parameters of exported functions, public methods of exported classes, and methods of exported or returned objects. Component props and callback type declarations remain outside scope.

A named type alias or interface must have the same property names and optional properties. TypeScript must accept the property types in both directions. Matching any properties and matching unknown properties count as the same shape. The comparison checks broad types recursively through nested properties, index values, union members, and function signatures. Identical any types match, as do identical unknown types. Broad and specific types do not match merely because TypeScript permits assignment. The rule also reports a repeated inline shape within one package. The message names the existing declaration and its repository-relative file and line.

The rule searches source files in the TypeScript program. Generated, vendored, shared, and local declarations can supply named types. The search excludes node_modules, TypeScript library files, explicitly identified fixture files, and declaration files whose output paths TypeScript maps from sources in the program. A matching file name alone does not prove that a declaration is compiled. A package is the nearest directory with a package.json file. A missing package prevents a repeated-inline match.

The rule requires TypeScript parser services. Missing services produce an error. It runs in the typed ESLint pass. Unique inline contracts stay allowed.

Structural equality does not prove that two types describe the same concept. Review the reported declaration before replacing a parameter type. Fresh measurements and their limits belong in the field notes.

The optional `fixtureFiles` list names fixture files relative to the ESLint working directory, or by absolute path. Supply it only when repository evidence identifies those files as fixtures. Directory names alone do not establish that category. An unlisted file remains eligible as a type owner.

## Superseded measurement on October 13, 2026: no-inline-structural-type-at-use-site

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 14068 hits in 33 repositories. The new rule reports 4606 hits in 30 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 16 true, for 80% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: samchungy-zod-openapi, honojs-hono, TanStack-router, excalidraw-excalidraw, mikro-orm-mikro-orm, better-auth-better-auth, calcom-cal.com, twentyhq-twenty, elysiajs-elysia, ts-rest-ts-rest, mastra-ai-mastra, drizzle-team-drizzle-orm, typeorm-typeorm, documenso-documenso, openstatusHQ-openstatus, payloadcms-payload. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 10. Four reports match different concepts or an expected type assertion. Structural compatibility does not establish shared ownership. Identical any properties and identical unknown properties match. The earlier blanket rejection of these broad types is superseded. Only broad-to-specific matches based solely on assignment are rejected.

This superseded evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix/superseded-owner-fix-round`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-inline-structural-type-at-use-site.labels.tsv`. SHA256: `34177b1d3dca87458224e2c0384b7deb7192e7fb08c9ba17b27f2326247ef569`. Frozen at 2026-10-13T05:07:01.008868+00:00.
- Label file: `dropped-no-inline-structural-type-at-use-site.labels.tsv`. SHA256: `1c98beb3f9ea34fdf9107331fb97b1ad2cad338b3aa2870264bd91ddbda3eced`. Frozen at 2026-10-13T05:07:17.062022+00:00.

## Superseded precision history

Superseded October 12, 2026 study. The syntax rule reported 3,152 hits in 45 repositories. Its first frozen sample scored 5/20. A fresh sample scored 11/20. A one-property exemption was tried and removed because W4 has no property-count exception. The current rule requires a matching owner or repeated shape.

The October 12 study uses 84 TypeScript roots: 40 local roots and 44 on sushi. It excludes vendor, build, generated, fixture, mock, snapshot, and analyzer input trees. The October 13 fix round uses a different fresh corpus and the shipped lint population. These studies are not interchangeable.

Review correction: the frozen October 13 label 20 for Payload getCustomGlobalViewByRoute.ts:12 is false because its owners are different. The frozen file is unchanged. A separate review note records the correction. The original 16/20 score becomes 15/20 under that review. Nested broad types were not fully checked in that implementation. The fix round checks them recursively.

## Fresh measurement on October 13, 2026: no-inline-structural-type-at-use-site

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 14037 hits in 33 repositories. The new rule reports 4401 hits in 30 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 13 true, for 65% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: microsoft-playwright, ts-rest-ts-rest, drizzle-team-drizzle-orm, vercel-ai, TanStack-router, pingdotgg-t3code, trpc-trpc, elysiajs-elysia, openstatusHQ-openstatus, vitejs-vite, samchungy-zod-openapi, vuejs-core, inngest-inngest-js. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 1 true reports out of 10. Identical broad types match. Nested broad-to-specific assignments do not. Arrays and tuples compare their elements directly. Structural compatibility can still join unrelated concepts. Review the reported owner before reusing it. The fresh 13/20 sample is below 70%. Seven reports match different owners or unresolved imported contracts. The dropped sample includes a real repeated page contract that the rule misses. The rule remains enabled; this precision limit needs owner review.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-inline-structural-type-at-use-site.labels.tsv`. SHA256: `5b3e2374ce031f7a207aa64f7609b23ec4deb3336100d8c66f98794ddede176f`. Frozen at 2026-10-13T07:14:23.636005+00:00.
- Label file: `dropped-no-inline-structural-type-at-use-site.labels.tsv`. SHA256: `c754121fe21fc912cff1ed6daeecd272cf8f648ce22e1f155372c69a42ed4055`. Frozen at 2026-10-13T07:15:30.228806+00:00.
