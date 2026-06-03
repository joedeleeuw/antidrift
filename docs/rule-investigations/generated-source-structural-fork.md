# Generated-Source Structural Fork Investigation

## Candidate

Extend structural fork detection from installed package exports to local generated-source or generated-wrapper types declared in `policy/registries/generated.yaml`.

## Status

Implemented as a registry-backed mode of `antidrift/no-structural-type-fork`, not as a separate rule. The rule remains installed-package-only unless `generatedSources` is configured.

## Ecosystem Check

No generic ESLint rule can know which generated source is canonical for a repository. Existing import restrictions can block direct generated imports, but they do not catch hand-written local structural copies of generated types.

## Potential Custom Solve

Use TypeChecker plus the generated registry:

1. Resolve configured generated wrapper exports into canonical object types.
2. Compare local type/interface declarations against canonical required-property fingerprints.
3. Allow anchored derivations such as imports, aliases, `Pick`, `Omit`, and sanctioned boundary DTOs.
4. Report hand-written structural copies that should import or derive from the generated owner.

This is the implemented shape. The shared ESLint config passes `policy/registries/generated.yaml` into `antidrift/no-structural-type-fork`.

## Known Risks

- Small object shapes collide.
- Boundary DTOs may intentionally mirror wire contracts.
- Generated wrappers must be inside the active TypeScript Program or project references.

## Entry Conditions

- Satisfied locally by Chaski BFF: `orders-ops-router.ts` redeclares `LineItemDetailRow` from generated `LineItemDetail`, and `service-stop-router.ts` redeclares `LineItemCounts` from generated `LineItemCountsByOrder`.
- Clean controls include generated imports, installed base-client aliases, local tuple aliases, and `Omit<ViewState, "padding">` utility derivation.
- Stable promotion still needs another independent repository and broad inventory classification when generated sources are configured.
