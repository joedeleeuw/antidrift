# Generated-Source Structural Fork Investigation

## Candidate

Extend structural fork detection from installed package exports to local generated-source or generated-wrapper types declared in `policy/registries/generated.yaml`.

## Status

Implemented as registry-backed modes of `antidrift/no-structural-type-fork`, not as separate rules. Configured `generatedSources` and `ownership.yaml` `packageTypeOwners` are accepted owner authority and can block. Unaccepted installed-package matches are inventory/proposal facts when a semantic fact sink is configured.

Convex generated owners are a third, implicit owner source: no registry entry is required because Convex codegen fixes the module paths. When the active TypeScript Program contains a module ending in `convex/_generated/dataModel`, every `Doc<"table">` owner is expanded from the exported `DataModel` table map (`DataModel[table].document` is exactly what convex's `DocumentByName` resolves). When the program contains a module ending in `convex/_generated/api`, the exported `api` object's `FilterApi` tree is walked to its function-reference leaves and each leaf's `_returnType` property is the `FunctionReturnType<typeof api.*>` owner (convex defines `FunctionReturnType<FuncRef> = FuncRef["_returnType"]`). Both candidate sets are accepted authority and block on exact copies. Files under any `convex/_generated/` path are exempt (generated output is owner, never fork), and bare reference aliases such as `type Row = Doc<"machines">` or `type Result = FunctionReturnType<typeof api.machines.get>` are derivations, exempted by resolving the referenced symbol's declarations to the convex-owned modules.

Convex types carry no Zod-style refinements, so checker-level structural identity is sound for them — the no-parse-as-cast lesson (structural equality cannot prove a schema contract because refinements are invisible to the checker) does not apply to plain generated shapes.

Exactness is the existing fingerprint comparison: same property count, same property names, same checker-rendered property types. Renamed, retyped, added, or dropped properties break the match and stay silent. Property order is insignificant because TypeScript object types are unordered; a reordered-but-identical redeclaration is still an exact copy and reports.

## Ecosystem Check

No generic ecosystem rule can know which generated source is canonical for a repository. Existing import restrictions can block direct generated imports, but they do not catch hand-written local structural copies of generated types.

## Potential Custom Solve

Use TypeChecker plus generated and ownership registries:

1. Resolve configured generated wrapper exports into canonical object types.
2. Resolve accepted package owner exports from `policy/registries/ownership.yaml`.
3. Compare local type/interface declarations against canonical exact-property fingerprints.
4. Allow anchored derivations such as imports, aliases, `Pick`, `Omit`, and sanctioned boundary DTOs.
5. Report hand-written exact structural copies that should import or derive from the accepted owner.

This is the implemented shape. The distributable TypeChecker config loads generated and ownership registry facts for `antidrift/no-structural-type-fork`.

## Decision

Keep `antidrift/no-structural-type-fork` ready and default-on for configured generated sources and accepted package owners while `stable` remains false. The accepted-owner branch is real TypeChecker proof: diagnostics require an exact local object/interface copy of a configured generated-source or accepted package-owner export.

Do not treat broad installed-package structural matches as blocking. They are discovery/proposal facts only when a semantic fact sink is configured. Independent replication and real accepted-owner evidence still gate stable promotion.

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
