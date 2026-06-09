# no-status-triplet-state Investigation

## Status

Implemented, but default-off in the shared config.

Current detector: React-specific configurable `useState` name groups for data/result/user/items, loading/pending, and error/failure. It reports when one function owns at least one state cell from each group. That is an inventory signal, not the final proof shape.

## Problem To Preserve

In React components and hooks, async/resource lifecycle state should not drift into separate local cells when one or more cells can be derived or inferred from the resource value or transition. The smell is not "three variables bad"; it is split lifecycle state that makes derived facts separately mutable.

The preferred construction pattern in `docs/build-patterns.md` is one reducer/resource value, such as a discriminated result union.

Known real evidence currently recorded in `docs/real-corpus-validation.md`:

- Drift: Chaski `src/frontend/crow-v2/hooks/useTeamMembers.ts` line 33.
- Clean: Chaski `src/frontend/monolithui/src/components/Products.tsx` uses query state without local `data/loading/error` cells.
- Current inventory note: 2 findings across 2 files.

## Eliminated Approaches

| Approach | Rationale |
| --- | --- |
| Raw `useState` count / "N state cells" | Multiple independent state cells are normal. Count does not prove a shared lifecycle. |
| Blocking `data/loading/error` name triplets by default | The current signal is name-based and heuristic. It can find inventory, but names alone do not prove that `loading` or `error` is derivable from the resource state. |
| Generic "prefer reducer" rule | Too broad without proof that the state values update together, model one resource lifecycle, or include separately mutable derived facts. |

## Possible Better Shape

Unproven idea: replace this with a narrower React split-resource-lifecycle rule that requires more than names:

1. multiple local state cells in one component/hook;
2. async/resource boundary evidence in the same scope;
3. setter coupling across loading/data/error-like cells in the same effect, handler, or lifecycle branch;
4. evidence that at least one cell is derivable from the resource state or transition;
5. a clean replacement path to one resource value, reducer, query state, or discriminated union.

Do not implement that shape without a new real drift/clean matrix. Until then, keep this rule off or retire it.
