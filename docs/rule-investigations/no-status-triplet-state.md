# no-status-triplet-state Investigation

## Status

Retired and locked.

The former detector used React-specific configurable `useState` name groups for data/result/user/items, loading/pending, and error/failure. It reported when one function owned at least one state cell from each group. That was an inventory signal, not proof.

The provable subset now lives in `antidrift/no-handrolled-resource-lifecycle-cells`, backed by the React state graph adapter and behavior-classified lifecycle writes.

## Problem To Preserve

In React components and hooks, async/resource lifecycle state should not drift into separate local cells when one or more cells can be derived or inferred from the resource value or transition. The smell is not "three variables bad"; it is split lifecycle state that makes derived facts separately mutable.

The preferred construction pattern in `docs/build-patterns.md` is one reducer/resource value, such as a discriminated result union.

Historical real evidence:

- Drift: Chaski `src/frontend/crow-v2/hooks/useTeamMembers.ts` line 33.
- Clean: Chaski `src/frontend/monolithui/src/components/Products.tsx` uses query state without local `data/loading/error` cells.
- Current inventory note: 2 findings across 2 files.

## Eliminated Approaches

| Approach                                               | Rationale                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `useState` count / "N state cells"                 | Multiple independent state cells are normal. Count does not prove a shared lifecycle.                                                                               |
| Blocking `data/loading/error` name triplets by default | The current signal is name-based and heuristic. It can find inventory, but names alone do not prove that `loading` or `error` is derivable from the resource state. |
| Generic "prefer reducer" rule                          | Too broad without proof that the state values update together, model one resource lifecycle, or include separately mutable derived facts.                           |

## Final Shape

The replacement is the narrower React split-resource-lifecycle branch in `no-handrolled-resource-lifecycle-cells`:

1. multiple local state cells in one component/hook;
2. async/resource boundary evidence in the same scope;
3. behavior-classified setter coupling in the same effect, handler, or lifecycle branch;
4. evidence that at least one lifecycle cell is derivable from the resource state or transition;
5. a clean replacement path to one resource value, reducer, query state, or discriminated union.

The implemented blocking proof is intentionally narrower than broad co-mutation: a transition must toggle a boolean lifecycle cell, reset and assign an error cell, and assign a distinct state cell from a bare awaited resource value. Two payload setters such as `setDataOne(nextLeft)` and `setDataTwo(nextRight)` are not a warning; they can emit inventory facts when scanned with an aggressive threshold, but inventory is not ESLint enforcement.

Member and destructured writes from awaited resources are not promoted to blocking proof yet. Without stronger type/control-flow facts, treating every `result.member` write as a resource payload would also catch pagination cursors, response metadata, and other clean multi-cell updates.

Do not reintroduce the standalone name-group rule without new real-code evidence and a deterministic proof not already covered by `no-handrolled-resource-lifecycle-cells`.
