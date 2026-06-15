# Domain Canonical Model Fork Investigation

## Implemented V1

Detect local redeclarations of repo-owned domain models that should import or derive from `packages/domain` or another configured canonical domain owner.

## Ecosystem Check

General TypeScript and ESLint rules cannot know repository domain ownership. Existing domain literal rules cover status and role unions, but not whole model forks.

## Custom Solve

Use TypeChecker plus `policy/registries/domain.yaml`:

1. Resolve configured canonical domain entities.
2. Compare local object type/interface declarations against the canonical model shape.
3. Allow aliases, imports, utility-type derivations, and explicitly sanctioned boundary DTOs.
4. Report local structural copies that should import or derive from the canonical owner.

Implemented as `antidrift/no-canonical-model-fork`. The rule is inert unless `canonicalEntities` are configured. Only exported canonical object types with at least four properties become candidates, which keeps small incidental shapes such as `{ year, month, day }` out of scope. On the local repo corpus, `UserDto = z.infer<typeof userDtoSchema>` is intentionally clean because schema-inferred DTO aliases are not hand-written object model forks.

## Real Corpus Evidence

Chaski report types provide the primary real-program gate:

- Drift: `src/frontend/portal/components/reports/action-items/types.ts` redeclares `ActionItem`, `Stop`, and `ActionItemsReport` from `src/frontend/portal/types/reports.ts`.
- Clean owner: `src/frontend/portal/types/reports.ts`.
- Clean sibling model: `src/frontend/portal/components/reports/weekly-digest/types.ts` imports shared report primitives but defines a different weekly digest report shape.

The local `Account` and `TDay` declarations in the drift file are not asserted: `Account` is not exported by the canonical owner, and `TDay` has fewer than four comparable properties.

Sudocode provides second-repo configured-owner evidence:

- Drift: `frontend/src/types/project.ts` redeclares `ProjectInfo` from `server/src/types/project.ts`.
- Clean owner: `server/src/types/project.ts`.
- Clean derivation: `OpenProjectInfo extends ProjectInfo` in the frontend file is not reported.
- Harness note: the corpus case supplies an explicit cross-project TypeScript Program because the owner and target span server/frontend tsconfigs.

## Known Risks

- Domain models, DTOs, view models, and wire contracts can legitimately overlap.
- Small models produce high false-positive risk, so the current rule uses the shared four-property threshold.
- Stable promotion still needs fresh adversarial review and broader boundary DTO/view-model clean pressure.

## Entry Conditions

- A second real repository contains a configured domain model fork.
- A second real repository contains clean owner and derivation controls.
- Any needed sanctioned-boundary allowlist shape is proven by real code before broad enablement.
- Claude Opus 4.8 review has read the registry, implementation, and corpus evidence.
