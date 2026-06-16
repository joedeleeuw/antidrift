# `antidrift/no-shattered-ingested-entity-state`

Status: under-proven, default-off.

## Failure

Agent-written React code often ingests one entity or resource object, then immediately splits its members across sibling `useState` cells:

```ts
const user = await fetchUser()
setId(user.id)
setName(user.name)
```

The broken association is not the shared `user*` name prefix. It is source-member provenance: multiple local state cells receive distinct members of the same freshly awaited source object in one transition. The preferred shape keeps the ingested entity/resource together, or moves the transition into a reducer/resource hook that owns the lifecycle.

## Proof Floor

The behavioral proof is AST plus local scope/control-flow:

- recover `useState` cell/setter bindings,
- record identifiers bound to awaited values in a transition,
- record setter arguments that read members of that awaited source,
- group writes by source binding,
- identify when at least two distinct cells receive at least two distinct members from the same source in the same transition.

This deliberately excludes name-prefix inventory, raw state-cell count, and recombination alone. Those remain research/inventory signals for `react/no-use-state-waterfall`.

The enforcement tier adds TypeChecker ownership proof at the rule layer. After the behavioral source-member fan-out is proven, the rule resolves the awaited source binding's initializer with TypeScript parser services and requires the resulting type to resolve to exactly one accepted owned entity from the domain/generated authority index. Every fanned member must also be present in `typeProps` for that owned type. Only this behavioral plus type-owner intersection emits the blocking `sourceMemberStateShard` fact and diagnostic.

Behavioral source-member fan-out without owned-entity proof is still useful evidence, but it is inventory-only. Those cases emit `sourceMemberStateShardCandidate` and do not block.

## False-Positive Boundary

Editable draft fields must stay clean. Hydrating a form from one entity is idiomatic when each cell is controlled by an input and independently edited:

```tsx
setName(user.name)
return <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
```

The adapter therefore suppresses source-shard proof for cells that are both controlled by `value`/`checked` and updated from an event-derived setter. Pagination metadata, query cursors, response envelopes, and anonymous view models are non-owned sources, so the type-owner tier keeps them out of enforcement while preserving candidate inventory. Large owned entities intentionally split into tab, wizard, or section view state remain the main false-positive class to validate before default enablement.

## Ecosystem

No maintained React, React Hooks, or `typescript-eslint` rule was found that models setter-to-source-member cohesion. Hooks rules own legality, dependency, and derivation problems; they do not reason about one fetched object being shattered into sibling state cells.

## Current Evidence

- Drift: Chaski `src/frontend/portal/pages/reports/weekly-digest.tsx` line 81 fetches one report object, then writes `weeklyDigestReports` and `teamOverview` into sibling state cells.
- Clean: Chaski `src/frontend/monolithui/src/components/EditPOModal.tsx` keeps a controlled input draft cell clean.
- Type-owner tier: the Chaski weekly-digest source is an unregistered response object, so it stays `sourceMemberStateShardCandidate` inventory rather than an enforcement finding. Blocking coverage grows with the accepted owned entity set.

## Validation Plan

1. Keep the rule default-off while collecting facts.
2. Run the `react-state` semantic adapter and the type-owner rule tier across local React repo copies.
3. Pin multiple clean controls: edit-form hydration, pagination, SWR/query resources, response envelopes, and intentional view-state derivation.
4. Pin at least one independent owned-entity drift repository.
5. Decide whether accepted cases stay in this rule or become the proven subset of `react/no-use-state-waterfall`.
