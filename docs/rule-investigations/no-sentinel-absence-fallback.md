# no-sentinel-absence-fallback

## Rule

Directive G7 requires absence to stay distinct from a reported value. The rule reports a member read followed by `??` and one of these strings: `unknown`, `n/a`, `none`, `unavailable`, `error`, or `missing`. Letter case does not matter. A template literal without substitutions also counts.

The owner ruling on October 12, 2026 applies to text shown to people. A log, console message, spinner, or status label must distinguish a missing report from a real value. For example, `props.ActiveState ?? "unknown"` hides that distinction. Display use is not an exemption.

The rule does not check numeric fallbacks, other strings, the `||` operator, or a left operand that is a call or a plain identifier. These limits describe the current match. They do not make those forms valid under G7.

## Change

The previous implementation exempts console calls and rendered children. This change removes that exemption to follow the owner ruling. It keeps the member-read and fallback checks. No existing test case changes its expected result. No test case or fixture is added.

## Earlier evidence

The earlier two-corpus study reports 286 hits in 29 repositories and 6 true hits in a sample of 20. A display exemption reduces the population to 265 hits in 25 repositories. A later sample labels 8 of 20 hits true. Those labels treat display-only fallbacks as allowed. The October 12 owner ruling supersedes that interpretation. The fresh measurement below uses G7 and the owner ruling.

The first recorded examples come from the murderbox runtime status readers. The rule is enabled in the ESLint pass. Its match depends on syntax and a fixed set of strings; it does not prove whether a fallback can run.

## Superseded measurement on October 13, 2026: no-sentinel-absence-fallback

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 499 hits in 21 repositories. The new rule reports 549 hits in 21 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 19 true, for 95% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: payloadcms-payload, withastro-astro, arktypeio-arktype, documenso-documenso, trpc-trpc, vitejs-vite, mastra-ai-mastra, formbricks-formbricks, mikro-orm-mikro-orm, triggerdotdev-trigger.dev, vercel-ai, TanStack-router, calcom-cal.com, microsoft-playwright, TanStack-query, Effect-TS-effect, twentyhq-twenty, pingdotgg-t3code, better-auth-better-auth. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 0. There are no dropped hits. Display-only fallbacks remain violations under the owner ruling of October 12, 2026. The implementation removes its earlier display exemption. It makes no other pattern change. The false report has a preceding guard that makes the fallback unreachable; the rule does not prove that control flow.

This superseded evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix/superseded-owner-fix-round`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-sentinel-absence-fallback.labels.tsv`. SHA256: `d73ba8cc2c68d71be8cde0667646876263fe1b0b374e8c4e23ed8a0e2867ea64`. Frozen at 2026-10-13T05:07:01.009228+00:00.
- Label file: `dropped-no-sentinel-absence-fallback.labels.tsv`. SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Frozen at 2026-10-13T05:07:17.062187+00:00.

## Fresh measurement on October 13, 2026: no-sentinel-absence-fallback

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 499 hits in 21 repositories. The new rule reports 549 hits in 21 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 16 true, for 80% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: twentyhq-twenty, payloadcms-payload, formbricks-formbricks, pingdotgg-t3code, mikro-orm-mikro-orm, vercel-ai, inngest-inngest-js, TanStack-query, calcom-cal.com, openstatusHQ-openstatus, withastro-astro, TanStack-router, trpc-trpc, documenso-documenso, mastra-ai-mastra, triggerdotdev-trigger.dev. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 0. There are no dropped hits. G7 requires absence to stay absence. Display-only fallbacks remain violations. The earlier display exemption is removed; no other sentinel match changes. False reports include declared domain modes and an unreachable fallback on a required expression. These are not display exemptions. No further source change is made in this round.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-sentinel-absence-fallback.labels.tsv`. SHA256: `4ff282f6e0ec44ff73174bdf3d4902a1119b70ceff7d62acf95ec6b6f6b4292e`. Frozen at 2026-10-13T07:14:23.636400+00:00.
- Label file: `dropped-no-sentinel-absence-fallback.labels.tsv`. SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Frozen at 2026-10-13T07:15:30.228969+00:00.
