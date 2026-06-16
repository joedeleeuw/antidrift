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

There is no enforcement tier. An earlier type-owner tier — which resolved the awaited source's type against the domain/generated authority index (the same machinery as `no-structural-type-fork`) and blocked only owned-entity shatters — was removed after multi-repo scans (chaski, sudocode) found zero real human-authored owned-entity shatters; every behavioral hit was a response envelope, value object, or computed result, which the rule correctly leaves alone.

The rule is inventory-only: behavioral source-member fan-out is recorded as `sourceMemberStateShardCandidate` and never blocks. Rebuilding the enforcement tier requires several real owned-entity shatters across more than one repo (likely an agent-generated corpus).

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

- No real-corpus enforcement positive yet: a type-aware scan of 335 portal components found zero owned-entity shatters (the one behavioral candidate was a response-envelope split, correctly not blocked). Owner-confirmed enforcement is exercised only synthetically (RuleTester `User`/`GeneratedRelease` splits).
- Clean control: Chaski `src/frontend/monolithui/src/components/EditPOModal.tsx` keeps a controlled input draft cell clean.
- Next: mine a real owned-entity shatter across the available repos before any `off`→`error` flip; blocking coverage grows with the accepted owned-entity set.

## Validation Plan

1. Keep the rule default-off while collecting facts.
2. Run the `react-state` semantic adapter and the type-owner rule tier across local React repo copies.
3. Pin multiple clean controls: edit-form hydration, pagination, SWR/query resources, response envelopes, and intentional view-state derivation.
4. Pin at least one independent owned-entity drift repository.
5. Decide whether accepted cases stay in this rule or become the proven subset of `react/no-use-state-waterfall`.
