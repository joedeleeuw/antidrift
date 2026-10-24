# no-open-dictionary-at-boundary

Retired. `@joedeleeuw/typescript-tooling` now owns explicit-`any` enforcement through the maintained TypeScript rules in both lint runtimes. The custom implementation is removed; its identifier and replacement remain in `policy/registries/rules.yaml`. The investigation below is historical evidence, not a description of an active Antidrift rule.

An exported dictionary of `any` lets callers skip type checks. Use the owner type when one exists. Use `unknown` for input that still needs decoding.

The rule reports `Record<string, any>` and `{ [key: string]: any }` in exported function parameters, returns, and variable annotations. It includes nested annotations and separately exported declarations. Private declarations and generic constraints stay allowed. The rule does not expand named aliases or inferred types.

`Record<string, unknown>` stays allowed. TypeScript requires callers to narrow its values before using them.

The rule runs in the ESLint pass. The `allows` option exempts exact exported names. There is no automatic fix because the caller must choose the right contract.

Earlier measurements included unknown-valued dictionaries. Those measurements do not describe the narrowed rule. Fresh measurements and their limits belong in the field notes.

## Superseded measurement on October 13, 2026: no-open-dictionary-at-boundary

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 1550 hits in 34 repositories. The new rule reports 440 hits in 24 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 18 true, for 90% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: sveltejs-kit, calcom-cal.com, vitest-dev-vitest, payloadcms-payload, TanStack-router, mastra-ai-mastra, edmundhung-conform, triggerdotdev-trigger.dev, microsoft-playwright, mikro-orm-mikro-orm, excalidraw-excalidraw, elysiajs-elysia, twentyhq-twenty, formbricks-formbricks, better-auth-better-auth, vitejs-vite, anatine-zod-plugins, withastro-astro. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 10. The two false reports are a hidden implementation annotation behind a named exported signature and a generic constraint nested in a variable annotation. These remain limitations.

This superseded evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix/superseded-owner-fix-round`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-open-dictionary-at-boundary.labels.tsv`. SHA256: `0e803349e71f37f9e8c4533109cec7b6e091cd8ac13c9532582b209f582d27cc`. Frozen at 2026-10-13T05:07:01.008738+00:00.
- Label file: `dropped-no-open-dictionary-at-boundary.labels.tsv`. SHA256: `a464755f9945d2910dca3e5185f53251d2df679e2aff015b7398d340727cc6c6`. Frozen at 2026-10-13T05:07:17.061958+00:00.

## Superseded precision history

Superseded October 12, 2026 study. Before excluding type parameters, 403 hits in 30 repositories scored 11/20. After that change, 356 hits in 29 repositories scored 10/20. Both samples fell below 70%. The current rule checks only dictionaries of any.

The October 12 study uses 84 TypeScript roots: 40 local roots and 44 on sushi. It excludes vendor, build, generated, fixture, mock, snapshot, and analyzer input trees. The October 13 fix round uses a different fresh corpus and the shipped lint population. These studies are not interchangeable.

## Fresh measurement on October 13, 2026: no-open-dictionary-at-boundary

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 1539 hits in 32 repositories. The new rule reports 434 hits in 22 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 18 true, for 90% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: TanStack-router, formbricks-formbricks, TanStack-query, vuejs-core, triggerdotdev-trigger.dev, calcom-cal.com, twentyhq-twenty, better-auth-better-auth, vitest-dev-vitest, Effect-TS-effect, vercel-ai, withastro-astro, edmundhung-conform, vitejs-vite, microsoft-playwright, mastra-ai-mastra, payloadcms-payload. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 10. The rule checks explicit any-valued dictionaries at exported signatures and variable annotations. It does not resolve the intended owner type.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-open-dictionary-at-boundary.labels.tsv`. SHA256: `1123ca2d59ead782e0da1f5556cdf05ecc9ad213f7783578e194c96619ed2f17`. Frozen at 2026-10-13T07:14:23.635868+00:00.
- Label file: `dropped-no-open-dictionary-at-boundary.labels.tsv`. SHA256: `e177e52a401adaa0cc7de4c4bad685b806988b754ddcfd92d47187e0e4de17c9`. Frozen at 2026-10-13T07:15:30.228746+00:00.
