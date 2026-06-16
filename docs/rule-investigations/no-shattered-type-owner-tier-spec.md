# Spec: type-owner tier for `antidrift/no-shattered-ingested-entity-state`

Design spec for the promotion path. The rule stays `under-proven` / default-off; this is the work
that makes it *promotable* to `error`. Build sequence: this spec → `gpt-5.5-extra-high` review →
`gpt-5.5-medium` implementation → `gpt-5.5-high` review → gate chain.

## Problem

The v1 behavioral proof (`sourceShardProof`, `react-state-graph.js:358`) blocks when ≥2 `useState`
cells each receive ≥2 distinct members of one awaited source in a transition. Pure member fan-out
**cannot** distinguish an entity shatter (`user.id` / `user.name`) from a response-envelope or
pagination split (`report.rows` / `report.summary`; `page.items` / `page.next`). Confirmed
irreducible for the behavioral signal (gpt-5.5-high). The repo's promotion model requires
TypeChecker/registry for any ownership claim (`docs/rule-roadmap.md:24,55`), and the rule's declared
`proofBuckets: [semantic-source-type-provenance]` already anticipates type provenance.

## Change: add a type-owner proof tier (compose, don't replace)

1. **Behavioral (existing, unchanged):** `sourceShardProof(frame)` proves the fan-out shape.
2. **Type-owner (new):** when parser services exist, resolve the awaited source binding's TS type and
   require it to resolve to **one accepted owned entity type**, with the fanned members being
   properties of that type.

**Block (enforcement fact + `context.report`) only when behavioral ∧ type-owner hold.** Every other
case emits the inventory fact and does **not** block.

## Reuse owned infrastructure (mint nothing new)

- `ESLintUtils.getParserServices` via the plugin's existing `requireTypeServices` pattern (same as
  the type-aware rules).
- Owner resolution already imported into `index.js` from `policy/lib/type-index.mjs`:
  `collectDomainCanonicalTypes` / `collectGeneratedCanonicalTypes` and
  `resolvesToDomainCanonicalType` / `resolvesToGeneratedType` — the same authority machinery
  `no-structural-type-fork` / `no-canonical-model-fork` use, adapter id `typescript-eslint/type-owner`.
- The proof is a composition inside the rule; the `react-state` adapter stays AST/scope-only (no
  TypeChecker added to it).

## Loud-failure discipline (corrected — first draft had a silent-fallback bug)

This rule becomes type-aware, so follow the existing typed-rule pattern, NOT silent degradation:
- Missing parser services → **loud `missingTypeServicesVisitors` guard** via `requireTypeServices`
  (the pattern `no-structural-type-fork` uses, `index.js:98` / `:2739`), plus a missing-services
  guard test. Do **not** silently fall back to inventory — that was the bug the xhigh review flagged.
- Source type resolves to a non-owned/anonymous shape → no enforcement (the behavioral inventory
  fact may still emit, but blocking requires the type proof).

## Fact contract + implementation requirements (review)

- `sourceMemberStateShard` ships enforcement-only (`confidence: deterministic-enforcement`,
  `emission: blocking-diagnostic`, `semantic-facts.mjs:43`) and `check-registries` pins the shipped
  contract (`check-registries.mjs:1272`). A non-blocking inventory emission needs **either** a
  contract expansion **or** a separate inventory fact kind — resolve before implementing.
- Use-site type resolution: bridge the awaited binding to `ts.Type` via `getTypeAtLocation` on its
  `await` init, then require `typeProps` membership for **all** fanned members.
- New FP class to control before promotion: a large owned entity intentionally split into
  tab/wizard/section view state (cells that are NOT controlled inputs); the `editableCells` escape
  (`react-state-graph.js:359`) doesn't cover it.

## KEY decision — what counts as an "entity" (the xhigh review changed this)

Domain/generated-only **empties the drift set**: registries hold only `User`/`Project`
(`domain.yaml`), generated sources are empty (`generated.yaml`), and the pinned Chaski drift's
source (`GetListWeeklyDigestReportResponse`) is an ad-hoc API response, not registered. So scope (b)
catches ~nothing real, and "any named type" re-admits the envelope FP (a view response IS a named
type).

**RESOLVED — scope (A): the accepted-owner authority index, shared with `no-structural-type-fork`.**
Block only when the awaited source's type resolves to one **accepted owned entity** (domain /
generated / accepted package owner — the exact set `no-structural-type-fork` /
`no-canonical-model-fork` consume via `resolvesToDomainCanonicalType` / `resolvesToGeneratedType`),
**and** the fanned members are `typeProps` of that owned type. This reuses owned infrastructure
(no new heuristic — the scalar-field idea is rejected as a registry-free workaround), and makes the
two rules siblings on one authority index: **fork rule = don't *redefine* the owned entity; shard
rule = don't *shatter* it across state cells.**

Consequence (honest): the blockable drift set is only as large as the owned-entity set (today
`User`/`Project`) and grows with the authority index — the same growth `no-structural-type-fork`
rides. The rule is valuable as a per-owned-entity guardrail, not as a high-volume corpus finding.
The `weekly-digest` "drift" whose source is an unregistered ad-hoc response is therefore **not**
flagged by this tier (correctly — it isn't an owned entity); it stays behavioral inventory only.

New FP to control before the `off`→`error` flip: an owned entity intentionally split into
tab/wizard/section view state (cells that aren't controlled inputs) — needs a clean control beyond
the existing `editableCells` escape.

## Other open questions

- Members threshold: require ≥2 distinct properties **that are members of the owned type** (mirror
  the behavioral threshold), not merely ≥2 members.
- Keep as its own rule vs fold into `react/no-use-state-waterfall`: keep separate (distinct proof);
  revisit after corpus evidence, per the registry `nextAction`.

## Fixtures / tests (typed RuleTester, like `no-structural-type-fork`)

- INVALID (block): `const u: User = await fetchUser(); setId(u.id); setName(u.name)` where `User` is
  an owned domain/generated type.
- VALID (no block): pagination (`page.items` / `page.next`) and view-model envelope
  (`report.rows` / `report.summary`) where the source type is **not** an owned entity; missing
  parser services; anonymous/inline awaited shape.
- **Reclassify** the current INVALID fixture `setRows(report.rows); setSummary(report.summary)`
  (`index.test.mjs:339`): under the type tier it should be VALID unless `report` is an owned entity.

## Severity & promotion

Stays `"off"` / `under-proven` after this build. Promotion to `"error"` additionally requires the
corpus-evidence pass (referenceDoc Validation Plan) showing the type-tier FP rate is acceptable.
**This spec is necessary, not sufficient, for promotion.**

## Verification

Typed RuleTester for the new fixtures; then `pnpm policy:check-registries` (update referenceDoc +
concerns to record the type-owner tier), `check-rule-surface`, `lint`, `typecheck`, `test`,
`package:verify`, `verify-session`.

## Out of scope

The corpus-evidence pass (separate slice; gates the `off`→`error` flip) and
`react/no-use-state-waterfall` implementation.
