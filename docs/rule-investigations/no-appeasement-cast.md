# no-appeasement-cast Investigation

## Current Rule

`antidrift/no-appeasement-cast` is implemented and enabled. It is `ready`, but not `stable`.

The rule is type-aware. It reports a plain `as T` assertion when the source expression is `any` or `unknown` and the target is a named object contract with at least one resolved property.

The rule deliberately excludes branded targets, which are owned by `antidrift/no-cast-to-branded`, and `as unknown as T` tunnels, which are owned by `antidrift/no-unsafe-cast-chain`. There is no explicit SDK/API allowlist: typed SDK conversions stay clean because the source is not `any` or `unknown`.

This is different from `no-unsafe-cast-chain`, which only catches explicit cast tunnels such as `value as unknown as User`.

## Ecosystem Check

Closest supported rule:

- `@typescript-eslint/no-unsafe-type-assertion`

That upstream rule is real and high support. It catches some of the same bad assertions, but it is broader than the antidrift rule. In Chaski, the upstream rule also reports typed SDK/API conversion patterns that this package currently treats as clean controls because their source value is already typed. So the ecosystem rule is not an equivalent replacement for this project scope.

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

## Broad Inventory

Focused Chaski and external corpus gates pass for the known drift and clean controls. A broader rule-only inventory found more real programs to classify before stable promotion:

| Corpus               | Files checked | Rule findings | Notes                                                                             |
| -------------------- | ------------: | ------------: | --------------------------------------------------------------------------------- |
| Local antidrift repo |            50 |             0 | Maintained package surface stays clean.                                           |
| Chaski portal        |           802 |             9 | Includes the accepted Axios drift plus additional production casts.               |
| Chaski BFF           |           205 |             1 | Finding is in a test file. Generated files caused harness noise outside the rule. |
| Chaski monolithui    |           232 |             2 | Production findings need classification.                                          |
| Chaski crow-v2       |           223 |             3 | Production findings need classification.                                          |
| Codebase Atlas       |           161 |             3 | Two accepted drift cases plus one test finding.                                   |
| Sudocode server      |           260 |            37 | Likely generic/API-wrapper pressure; requires classification.                     |
| Sudocode frontend    |           360 |            14 | Requires classification.                                                          |
| Sudocode CLI         |           132 |            15 | Requires classification.                                                          |
| Sudocode MCP         |            26 |             1 | Requires classification.                                                          |

The broad inventory was run with an ad-hoc ESLint API harness. Some subprojects emitted tsconfig/generated-file parser messages, so only `antidrift/no-appeasement-cast` findings count as rule evidence. These findings are not labeled false positives yet, but none can count toward stable promotion until they are classified.

## False-Positive Risks

- Generic API wrappers that return `response.data as T` can be intentional boundary abstractions. The current rule must avoid turning every generic API client into noise unless the source is broad and the target is a named object contract used to silence missing validation.
- SDK conversion methods may produce values whose public type is narrower than the method signature. These need real clean controls before tightening.
- Test helpers and fixtures may intentionally cast broad values to create impossible states; those should be excluded by file scope or treated as lower-severity inventory, not used as production promotion evidence.
- Named array aliases or collection contracts may resolve to non-empty object-like targets and need real-corpus classification before broad claims.

## False-Negative Risks

- If a broad value is first assigned to a precise local type and then cast later, the rule may miss the original laundering site.
- Angle-bracket assertions such as `<User>value` are not visited by this v1 rule.
- A bad cast hidden behind a generic helper can appear as a typed source at the assertion site.

## Promotion State

This is the strongest current promotion candidate because it has real drift replication in Chaski, Codebase Atlas, and Sudocode.

It is not stable yet. Current state: locally ready, classification-required.

Remaining gates:

1. Classify the broad inventory, especially Sudocode generic/API-wrapper casts and Chaski production casts.
2. Decide whether test files need a config override or should continue reporting impossible-state casts.
3. Add a second explicit clean control from Codebase Atlas or Sudocode where a typed source conversion stays quiet.
4. Keep `stable: false` until classification is clean and the registry has no unresolved concerns.
