# no-cast-to-branded Investigation

## Status

Retired. It was implemented as `antidrift/no-cast-to-branded`, but removed from the active custom rule surface after review.

## Scope

Detect casts that manufacture branded values without crossing the owning validation boundary.

The positive pattern is:

```ts
const id = UserId.make(raw);
const parsed = UserIdSchema.parse(raw);
```

The drift pattern is:

```ts
const id = raw as UserId;
```

This is not the same as general unsafe assertions. `@typescript-eslint/no-unsafe-type-assertion` can report many branded casts, but it reports a much broader assertion policy and does not give brand-boundary guidance. In practice, the custom rule had no real non-test forged brand casts and only understood the under-adopted antidrift brand marker, so the separate lint rule was retired.

## Former Solve

The former rule was TypeChecker-backed and detected only the antidrift brand marker exported by `@joedeleeuw/antidrift/brand`.

That makes the rule precise for adopters of the antidrift brand utility, but weak as corpus evidence today: no real scanned repository currently uses the antidrift brand marker.

## Real Corpus Evidence

Codebase Atlas uses Zod brands heavily:

- `/Users/sushi/code/codebase-atlas/src/schemas/atlasGameState.ts` defines many `z.string().min(1).brand<...>()` schemas.
- `/Users/sushi/code/codebase-atlas/src/services/atlasIdService.ts` constructs those branded IDs through schema parses and stays clean.

Current limitation: this is only a clean parse-boundary control after the rule understands Zod-branded targets. Today it passes because the implementation does not detect Zod brands.

Known cast inventory:

- `/Users/sushi/code/codebase-atlas/src/routes/atlas.city3d.tsx` casts a checked scene literal to `GeneratedRepoId`, but that type is a literal union, not a brand.
- Several Codebase Atlas test files cast impossible branded IDs to assert runtime behavior. Those are test-only and not promotion evidence.
- `/Users/sushi/code/murderbox/apps/client/app/(chat)/index.tsx` casts a fallback string to `MachineId`; this is a branded/opaque-looking ID surface to inspect, but not yet confirmed as a Zod or antidrift brand target.

## Claude Advisory Review

Claude Opus 4.8 advisory review completed on June 8, 2026 (`reports/claude-rule-reviews/20260608-105342-branded-casts.md`). It read repo code through `Read`, `Grep`, and `Glob`; stderr was empty.

The review agreed:

- Keep the rule under-proven and default-off.
- Do not treat `@typescript-eslint/no-unsafe-type-assertion` as a replacement; it is a broader benchmark.
- Include Zod `.brand()` targets if this rule is expected to become useful against real repositories.
- Fix the current syntactic gap where `TSTypeAssertion` / angle-bracket assertions are not visited.
- Avoid stable promotion until real forged branded casts and clean parse-boundary controls replicate in independent repositories.

A second prospect review completed on June 8, 2026 (`reports/claude-prospect-reviews/20260608-132852-cast-to-branded.md`) after the wider rule-status cleanup. It sharpened the decision:

- Treat `@typescript-eslint/no-unsafe-type-assertion` as the standing benchmark, not a default replacement yet.
- Keep the rule default-off unless a real non-test forged brand cast appears.
- Add only correctness hardening before evidence: `TSTypeAssertion` coverage, symbol-based Zod brand detection, explicit double-cast ownership, and source gating for guarded casts.
- Add a sunset: if no real forged branded cast appears in a second independent repository by the next promotion cycle, retire the custom rule to `ecosystem-covered`.

## Known Risks

- Antidrift-marker-only detection makes real promotion nearly impossible until consumers adopt the brand kit.
- Zod brand detection must be symbol/type based, not name-string matching.
- `raw as unknown as Brand` is now delegated to `@typescript-eslint/no-unsafe-type-assertion`; no separate custom double-cast or brand-cast rule is active.
- Type-aware parser services are required; enabling the rule in a non-type-aware config intentionally reports configuration errors.
- The current clean controls are parse-boundary files with no cast node. They prove the preferred construction pattern, but they do not prove a cast-bearing false-positive boundary.

## Promotion Conditions

- Implement Zod brand target detection, or explicitly decide Zod brands are out of scope and keep the rule under-proven/off.
- Add `TSTypeAssertion` coverage if TypeScript source files can use angle-bracket casts.
- Find a real non-test forged brand cast in a repository that already uses branded validation boundaries.
- Find at least one real cast-bearing clean control, such as a guarded brand cast that should not report, before enabling.
- Keep real clean controls for schema/brand constructors.
- Require at least two independent repositories before stable promotion.

## Current Verdict

Retired.

The intended contract is understandable, but the current corpus gives it no work: Codebase Atlas uses Zod brands through parse boundaries, and the real non-test forged-cast count is still zero. Reopen only if a real repository has adopted branded validation boundaries and a non-test forged branded cast appears. Until then, keep the brand utility and let `@typescript-eslint/no-unsafe-type-assertion` own the broad assertion surface.
