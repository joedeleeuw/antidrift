# Domain Canonical Model Fork Investigation

## Implemented V1

Detect local redeclarations of repo-owned domain models that should import or derive from `packages/domain` or another configured canonical domain owner.

## Ecosystem Check

General TypeScript and ESLint rules cannot know repository domain ownership. Existing domain literal rules cover status and role unions, but not whole model forks.

Maintained adjacent coverage does not replace this rule:

- `@typescript-eslint/no-duplicate-type-constituents` only removes duplicate constituents inside one union or intersection type.
- `@typescript-eslint/consistent-type-definitions` only chooses `type` versus `interface` syntax.
- `@typescript-eslint/consistent-type-imports` only enforces type-only import style.
- ESLint `no-redeclare` only catches declarations in the same scope.
- Semgrep and CodeQL can express custom deterministic queries, but there is no maintained TypeScript rule that combines a project-owned canonical export registry with TypeChecker structural equality.

## Custom Solve

Use TypeChecker plus `policy/registries/domain.yaml`:

1. Resolve configured canonical domain entities.
2. Compare local object type/interface declarations against the canonical model shape with TypeChecker property/type strings.
3. Allow aliases, imports, and utility-type derivations such as `Pick`, `Omit`, `Partial`, `Readonly`, and `Required`.
4. Report exact local structural copies that should import or derive from the canonical owner.

Implemented as `antidrift/no-canonical-model-fork`. The rule is inert unless `canonicalEntities` are configured. Only exported canonical object types with at least four properties become candidates, which keeps small incidental shapes such as `{ year, month, day }` out of scope. On the local repo corpus, `UserDto = z.infer<typeof userDtoSchema>` is intentionally clean because schema-inferred DTO aliases are not hand-written object model forks.

The current proof is exact-owner-copy only: local and owner property names, property count, and checker-rendered property types must match after shared optionality normalization. This is real semantic AST evidence, not name matching or regex. It also means the rule does not discover new owners; the owner must already be configured.

## Real Corpus Evidence

Chaski report types provide the primary real-program gate:

- Drift: `src/frontend/portal/components/reports/action-items/types.ts` redeclares `ActionItem`, `Stop`, and `ActionItemsReport` from `src/frontend/portal/types/reports.ts`.
- Clean owner: `src/frontend/portal/types/reports.ts`.
- Clean sibling model: `src/frontend/portal/components/reports/weekly-digest/types.ts` imports shared report primitives but defines a different weekly digest report shape.

The local `Account` and `TDay` declarations in the drift file are not asserted: `Account` is not exported by the canonical owner, and `TDay` has fewer than four comparable properties.

Sudocode provides second-repo configured-owner evidence:

- Drift: `frontend/src/types/project.ts` redeclares `ProjectInfo` from `server/src/types/project.ts`.
- Clean owner: `server/src/types/project.ts`.
- Clean extension control: `OpenProjectInfo extends ProjectInfo` in the frontend file is not reported, but the current evidence only proves the non-exact extended shape stays clean. It does not prove a dedicated interface-`extends` derivation exemption.
- Harness note: the corpus case supplies an explicit cross-project TypeScript Program because the owner and target span server/frontend tsconfigs. A normal per-package frontend lint run would not see the server owner unless the consumer config builds a unified Program.

Current focused evidence:

```bash
pnpm exec antidrift chaski-corpus --slice canonical-model-fork-review --rules antidrift/no-canonical-model-fork --require
pnpm exec antidrift external-corpus --slice canonical-model-fork-review --rules antidrift/no-canonical-model-fork --require --min-repositories 1
```

Both commands pass against the local real repositories. The stricter external-only bar does not pass yet:

```bash
pnpm exec antidrift external-corpus --slice canonical-model-fork-review --rules antidrift/no-canonical-model-fork --require --min-repositories 2
```

That fails because only Sudocode currently has matching external canonical-model-fork cases; Chaski is covered by the separate Chaski corpus.

## Decision

Keep `antidrift/no-canonical-model-fork` as ready, default-off inventory. The implementation is real TypeChecker-backed semantic proof and is not covered by maintained ecosystem rules, but it is not ready for default-on blocking.

The blocker is not fake semantics. The blocker is policy classification: exact-overlap boundary DTOs, view models, and wire contracts can be legitimate, and the current corpus has not classified enough real clean pressure there.

## Known Risks

- Domain models, DTOs, view models, and wire contracts can legitimately overlap.
- Top-level optionality is normalized before structural comparison, so a partially loosened boundary shape may still match a canonical owner.
- Small models produce high false-positive risk, so the current rule uses the shared four-property threshold.
- Interface extension is not explicitly exempted; current clean evidence for `OpenProjectInfo extends ProjectInfo` comes from non-exact shape.
- Empty or nominal interface extensions such as `interface Local extends Owner {}` can still match exactly and report.
- Name-agnostic structural equality can attribute a coincidental exact shape to the wrong configured owner as the owner registry grows.
- False negatives are intentional for unconfigured owners, unexported owner types, owner types below four comparable properties, non-exact forks, copied owner models with extra fields, and owner files missing from the active TypeScript Program.
- Stable promotion still needs broader boundary DTO/view-model/wire-contract clean pressure.

## Entry Conditions

- A second real repository contains a configured domain model fork.
- A second real repository contains clean owner controls.
- Real exact-overlap boundary DTO, view-model, or wire-contract controls are classified clean, or a narrow sanctioned-boundary mechanism is proven from real code.
- Interface `extends` derivation semantics are explicitly covered if the intended contract is that derivations are always clean.
- Cross-tsconfig owner/fork detection is proven in the same lint operating mode consumers will run, or explicitly documented as requiring a unified Program.
- Any needed sanctioned-boundary allowlist shape is proven by real code before broad enablement.
- Claude Opus 4.8 review has read the registry, implementation, and corpus evidence.
