# no-appeasement-cast Investigation

## Current Rule

`antidrift/no-appeasement-cast` is implemented and enabled. It is `ready`, but not `stable`.

The rule is type-aware. It reports a plain `as T` assertion when the source expression is `any` or `unknown`, the target is a named nontrivial object contract, and the target is not a narrow SDK/API conversion escape that the current rule deliberately allows.

This is different from `no-unsafe-cast-chain`, which only catches explicit cast tunnels such as `value as unknown as User`.

## Ecosystem Check

Closest supported rule:

- `@typescript-eslint/no-unsafe-type-assertion`

That upstream rule is real and high support. It catches some of the same bad assertions, but it is broader than the antidrift rule. In Chaski, the upstream rule also reports SDK/API conversion patterns that this package currently treats as clean controls. So the ecosystem rule is not an equivalent replacement for this project scope.

## Real Corpus Evidence

### Drift

Chaski:

- `/Users/sushi/code/chaski/src/frontend/portal/api/apiService.ts` line 81 casts an unknown caught error to `AxiosError` only to read `response.status`.

Expected repair:

```ts
if (axios.isAxiosError(err)) {
  const statusCode = err.response?.status;
}
```

Codebase Atlas:

- `/Users/sushi/code/codebase-atlas/src/needle/AtlasNeedleRenderer.ts` line 200 casts `mesh.userData.baseEmissive` to `ThreeColor`.

Expected repair:

```ts
const baseEmissive = mesh.userData.baseEmissive;
if (baseEmissive instanceof this.THREE.Color) {
  material.emissive.copy(baseEmissive);
}
```

Codebase Atlas:

- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` line 646 casts broad input to `TerrainLayoutAnchor` before checking fields.

Expected repair:

```ts
if (!isRecord(value)) return false;
return (
  Number.isInteger(value.q) &&
  Number.isInteger(value.r) &&
  Array.isArray(value.position) &&
  value.position.length === 3 &&
  value.position.every((item) => typeof item === "number")
);
```

### Clean Controls

Chaski:

- `/Users/sushi/code/chaski/src/frontend/portal/lib/firebase/server.ts` converts `currentUser.toJSON()` to Firebase `User`. This stays clean because the source is a typed SDK object conversion, not an `any` or `unknown` appeasement cast.

Codebase Atlas adjacent clean pressure:

- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` has `isTerrainLayoutAnchor` as a legitimate predicate shape once it checks `q`, `r`, and `position`. The current implementation is still flagged because it casts before checking; the repair is to check through `Record<string, unknown>` or an equivalent object guard.

## False-Positive Risks

- Generic API wrappers that return `response.data as T` can be intentional boundary abstractions. The current rule must avoid turning every generic API client into noise unless the source is broad and the target is a named object contract used to silence missing validation.
- SDK conversion methods may produce values whose public type is narrower than the method signature. These need real clean controls before tightening.
- Test helpers and fixtures may intentionally cast broad values to create impossible states; those should be excluded by file scope or treated as lower-severity inventory, not used as production promotion evidence.

## False-Negative Risks

- If a broad value is first assigned to a precise local type and then cast later, the rule may miss the original laundering site.
- Structural interfaces with too few properties are below the rule's named-object threshold and may escape.
- A bad cast hidden behind a generic helper can appear as a typed source at the assertion site.

## Promotion State

This is the strongest current stable-promotion candidate because it has real drift replication in Chaski and Codebase Atlas.

It is not stable yet. Remaining gates:

1. Broad inventory across the current repo, Chaski, Sudocode, and Codebase Atlas must show no unclassified production false positives.
2. Claude Opus 4.8 advisory review must read the current code and explicitly assess the rule's signal, risks, and ecosystem overlap.
3. The registry must keep `stable: false` until both gates are clean.
