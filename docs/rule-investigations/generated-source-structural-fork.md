# Generated-Source Structural Fork Investigation

## Candidate

Extend structural fork detection from installed package exports to local generated-source or generated-wrapper types declared in `policy/registries/generated.yaml`.

## Status

Implemented as registry-backed modes of `antidrift/no-structural-type-fork`, not as separate rules. Configured `generatedSources` and `ownership.yaml` `packageTypeOwners` are accepted owner authority and can block. Unaccepted installed-package matches are inventory/proposal facts when a semantic fact sink is configured.

## Ecosystem Check

No generic ESLint rule can know which generated source is canonical for a repository. Existing import restrictions can block direct generated imports, but they do not catch hand-written local structural copies of generated types.

## Potential Custom Solve

Use TypeChecker plus generated and ownership registries:

1. Resolve configured generated wrapper exports into canonical object types.
2. Resolve accepted package owner exports from `policy/registries/ownership.yaml`.
3. Compare local type/interface declarations against canonical exact-property fingerprints.
4. Allow anchored derivations such as imports, aliases, `Pick`, `Omit`, and sanctioned boundary DTOs.
5. Report hand-written exact structural copies that should import or derive from the accepted owner.

This is the implemented shape. The shared ESLint config passes `policy/registries/generated.yaml` and optional `policy/registries/ownership.yaml` into `antidrift/no-structural-type-fork`.

## Decision

Keep `antidrift/no-structural-type-fork` as ready, default-off inventory. The accepted-owner branch is real TypeChecker proof: diagnostics require an exact local object/interface copy of a configured generated-source or accepted package-owner export.

Do not treat broad installed-package structural matches as blocking. They are discovery/proposal facts only when a semantic fact sink is configured. Do not promote the rule until real exact-copy drift appears under an accepted owner configuration.

## Known Risks

- Small object shapes collide.
- Boundary DTOs may intentionally mirror wire contracts.
- Generated wrappers and accepted package owner declarations must be inside the active TypeScript Program or project references.
- Package-owner enforcement is only as strong as the accepted owner fact; broad installed-package proposals are discovery, not blocking proof.
- False negatives are intentional for unconfigured owners, owner types below the shared property threshold, non-exact forks, copied owner models with extra fields, and owner declarations outside the active TypeScript Program.

## Entry Conditions

- Chaski BFF now supplies projection clean controls: `orders-ops-router.ts` declares `LineItemDetailRow` as a local subset of generated `LineItemDetail`, and `service-stop-router.ts` declares `LineItemCounts` as a local subset of generated `LineItemCountsByOrder`. Those are not exact owner copies and should stay clean.
- Clean controls include generated imports, installed base-client aliases, local tuple aliases, projected DTOs, and `Omit<ViewState, "padding">` utility derivation.
- Stable promotion still needs real exact generated-source or accepted package-owner copy drift, another independent repository, broad inventory classification when generated sources are configured, and real accepted package-owner evidence before package owners are added.
