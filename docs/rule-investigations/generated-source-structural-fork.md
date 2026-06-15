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
3. Compare local type/interface declarations against canonical required-property fingerprints.
4. Allow anchored derivations such as imports, aliases, `Pick`, `Omit`, and sanctioned boundary DTOs.
5. Report hand-written structural copies that should import or derive from the accepted owner.

This is the implemented shape. The shared ESLint config passes `policy/registries/generated.yaml` and optional `policy/registries/ownership.yaml` into `antidrift/no-structural-type-fork`.

## Known Risks

- Small object shapes collide.
- Boundary DTOs may intentionally mirror wire contracts.
- Generated wrappers and accepted package owner declarations must be inside the active TypeScript Program or project references.
- Package-owner enforcement is only as strong as the accepted owner fact; broad installed-package proposals are discovery, not blocking proof.

## Entry Conditions

- Satisfied locally by Chaski BFF: `orders-ops-router.ts` redeclares `LineItemDetailRow` from generated `LineItemDetail`, and `service-stop-router.ts` redeclares `LineItemCounts` from generated `LineItemCountsByOrder`.
- Clean controls include generated imports, installed base-client aliases, local tuple aliases, and `Omit<ViewState, "padding">` utility derivation.
- Stable promotion still needs another independent repository, broad inventory classification when generated sources are configured, and real accepted package-owner evidence before package owners are added.
