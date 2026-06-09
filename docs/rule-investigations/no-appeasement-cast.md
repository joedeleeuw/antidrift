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

## Upstream Delta Benchmark

Run:

```bash
pnpm policy:benchmark-unsafe-type-assertion
```

The benchmark runs `@typescript-eslint/no-unsafe-type-assertion` beside the antidrift cast-family rules over real Chaski, Codebase Atlas, and Sudocode TypeScript programs. The current live-corpus source-only run checked 2,411 files and produced:

| Rule                                          | Findings |
| --------------------------------------------- | -------: |
| `antidrift/no-appeasement-cast`               |       85 |
| `antidrift/no-unsafe-cast-chain`              |       58 |
| `antidrift/no-cast-to-branded`                |        0 |
| `@typescript-eslint/no-unsafe-type-assertion` |    1,474 |

Location comparison:

| Result                                                              | Count |
| ------------------------------------------------------------------- | ----: |
| Locations reported by both upstream and antidrift cast-family rules |   142 |
| Upstream-only locations                                             | 1,331 |
| Antidrift-only locations                                            |     0 |

Interpretation: upstream is a strict superset on the measured corpus, but too broad to replace the custom rule as the default guardrail. Keep the custom rule for the `any`/`unknown` source-boundary contract and use the upstream benchmark as an optional stricter-policy delta.

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

- `/Users/sushi/code/codebase-atlas/src/needle/AtlasNeedleRenderer.ts` line 205 casts `mesh.userData.baseEmissive` to `ThreeColor`.
- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` line 1293 casts broad input to `TerrainLayoutAnchor` before checking fields.

Expected repair:

```ts
const baseEmissive = mesh.userData.baseEmissive;
if (baseEmissive instanceof this.THREE.Color) {
  material.emissive.copy(baseEmissive);
}
```

### Clean Controls

Chaski:

- `/Users/sushi/code/chaski/src/frontend/portal/lib/firebase/server.ts` converts `currentUser.toJSON()` to Firebase `User`. This stays clean because the source is a typed SDK object conversion, not an `any` or `unknown` appeasement cast.

Codebase Atlas adjacent clean pressure:

- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` has `isTerrainLayoutAnchor` as a legitimate predicate shape once it checks through a guard or delegates to the owning schema. The current live repo implementation is still flagged because it casts before checking.
- `/Users/sushi/code/codebase-atlas/src/bridge/AtlasSceneBridge.ts` casts a typed DOM `Event` to `CustomEvent<AtlasSceneEvent>` and stays clean because the source is not `any` or `unknown`.

## Remediation Evidence (2026-06-04)

Four production repairs have been applied in bracket-prefixed copies so the live repos are not modified:

```bash
pnpm policy:validate-appeasement-remediation
```

| Repo                | File                                                                                                                      | Old pattern                                                                 | Repair                                                                                                                             | Validation                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaski copy         | `/Users/sushi/code/[antidrift-no-appeasement-remediation]-chaski/src/frontend/portal/api/apiService.ts`                   | `err as AxiosError` on a caught `unknown`                                   | `isAxiosError(err)` guard before reading `response.status`                                                                         | `policy:validate-appeasement-remediation` passes; the copied file is a clean case.                                                            |
| Chaski copy         | `/Users/sushi/code/[antidrift-no-appeasement-remediation]-chaski/src/frontend/portal/components/ImpersonationWarning.tsx` | Three `JSON.parse(...) as ImpersonationData` storage casts                  | `parseStoredImpersonationData` parses into `unknown` and checks optional string/number fields before returning `ImpersonationData` | `policy:validate-appeasement-remediation` passes; the copied file is a clean case for serialized browser storage.                             |
| Codebase Atlas copy | `/Users/sushi/code/[antidrift-no-appeasement-remediation]-codebase-atlas/src/programs/persistenceCuration.ts`             | `value as TerrainLayoutAnchor` before checking fields                       | `TerrainLayoutAnchorSchema.safeParse(value).success`                                                                               | `policy:validate-appeasement-remediation` passes; the copied file is a clean case while `AtlasNeedleRenderer.ts` still proves adjacent drift. |
| Codebase Atlas copy | `/Users/sushi/code/[antidrift-no-appeasement-remediation]-codebase-atlas/src/needle/AtlasNeedleRenderer.ts`               | `mesh.userData.baseEmissive as ThreeColor` from a third-party user-data bag | `baseEmissive instanceof this.THREE.Color` guard before copying into the material                                                  | `policy:validate-appeasement-remediation` passes; the copied file is a clean case for third-party bag narrowing.                              |

The copied repos use `node_modules` symlinks back to the originals so type-aware rules resolve the same external contracts without changing the original working trees.

Focused inventory deltas after the repairs:

| Scope                                     | Before | After |
| ----------------------------------------- | -----: | ----: |
| Chaski targeted remediation files         |      4 |     0 |
| Codebase Atlas targeted remediation files |      2 |     0 |

## Broad Inventory

Focused Chaski and external corpus gates pass for the known drift and clean controls. A broader rule-only inventory found more real programs to classify before stable promotion:

| Corpus               | Files checked | Rule findings | Notes                                                                             |
| -------------------- | ------------: | ------------: | --------------------------------------------------------------------------------- |
| Local antidrift repo |            50 |             0 | Maintained package surface stays clean.                                           |
| Chaski portal        |           802 |             9 | Includes the accepted Axios drift plus additional production casts.               |
| Chaski BFF           |           205 |             1 | Finding is in a test file. Generated files caused harness noise outside the rule. |
| Chaski monolithui    |           232 |             2 | Production findings need classification.                                          |
| Chaski crow-v2       |           223 |             3 | Production findings need classification.                                          |
| Codebase Atlas       |           168 |             3 | Two accepted drift cases plus one test finding.                                   |
| Sudocode server      |           260 |            37 | Likely generic/API-wrapper pressure; requires classification.                     |
| Sudocode frontend    |           360 |            14 | Requires classification.                                                          |
| Sudocode CLI         |           132 |            15 | Requires classification.                                                          |
| Sudocode MCP         |            26 |             1 | Requires classification.                                                          |

The broad inventory was run with an ad-hoc ESLint API harness. Some subprojects emitted tsconfig/generated-file parser messages, so only `antidrift/no-appeasement-cast` findings count as rule evidence. These findings are not labeled false positives yet, but none can count toward stable promotion until they are classified.

## Full Classification (2026-06-04)

The broad inventory was rerun with `reports/no-appeasement-inventory.mjs` on June 4, 2026. It still reports 85 findings across the live Chaski, Codebase Atlas, and Sudocode repos. Every finding has a classification bucket. No production false-positive category was found; the remaining blocker is adoption/cleanup in real consumer repositories, not rule narrowing. The separate copy-backed remediation corpus demonstrates four accepted repair patterns without changing those live repos.

| Classification                       | Count | Examples                                                                                                             | Current decision                                                                                                                                                                                                                                      |
| ------------------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caught-error normalization casts     |    21 | Chaski `portal/api/apiService.ts`, Chaski `crow-v2/app/_layout.tsx`, Sudocode executor/worktree/repo-info catches    | Drift. Use `instanceof`, `axios.isAxiosError`, typed error guards, or a shared `normalizeError` helper. The Chaski remediation copy proves the `isAxiosError` repair pattern.                                                                         |
| Unvalidated serialized data casts    |    27 | Chaski `ImpersonationWarning.tsx`; Sudocode config, JSONL, YAML, workflow, sidecar, and `response.json()` readers    | Drift. Parse into `unknown`, then validate with a schema, generated decoder, or owned mapper before assigning the contract. The Chaski remediation copy proves the browser storage parser pattern.                                                    |
| Row/model/object contract casts      |    12 | Chaski PowerSync rows and TanStack table rows; Codebase Atlas `mesh.userData`; Sudocode DB rows and Claude tool args | Drift. Fix source generics, add typed row mappers, or guard third-party bags before claiming the model. The Codebase Atlas remediation copy proves both the schema-backed `TerrainLayoutAnchor` repair and the `THREE.Color` user-data guard pattern. |
| String-union / enum value casts      |    12 | Chaski toggle/select values; Sudocode editor, entity, relationship, agent, and narration priority values             | Drift. Validate against an allowed-value set or make the UI/router source carry the literal type.                                                                                                                                                     |
| Transport/API message contract casts |     5 | Sudocode websocket payloads and generic `ApiResponse<any>` unwrap                                                    | Drift. Use discriminated event schemas, generated clients, or response decoders. Generic wrappers are not a built-in exception.                                                                                                                       |
| Request-body boundary casts          |     5 | Sudocode import/config route bodies                                                                                  | Drift. Validate request bodies at the route boundary before destructuring.                                                                                                                                                                            |
| Test setup / impossible-state casts  |     3 | Chaski PostHog gateway test, Codebase Atlas persisted-project test, Sudocode hook test                               | Still reported. Tests are not production promotion evidence, but type-escape hatches in real tests should use typed builders, schema-validated fixture loaders, or focused local suppression with a reason.                                           |

No rule narrowing is justified from this inventory. Generic/API wrappers are not an exception to the rule: `response.json() as APIResponse<T>`, `response.data as ApiResponse<any>`, request-body casts, DB/YAML row casts, and websocket payload casts are boundary contract assertions and should be repaired with schema validation, a generated client/decoder, or a typed mapper.

Cloudflare Agents now has an external-corpus `known-gap` for the same family:
`packages/ai-chat/src/ws-chat-transport.ts` parses WebSocket `event.data` and asserts
`OutgoingMessage` / `UIMessageChunk` contracts before validation. This is not a
`no-unsafe-deserialize` gap because the parse input is a string; it is parse-output
contract authority owned by this rule once the checkout's unresolved `agents/tsconfig`
can be type-checked.

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

This is the strongest current promotion candidate because it has real drift replication in Chaski, Codebase Atlas, and Sudocode, plus remediation-pattern evidence in bracket-prefixed Chaski and Codebase Atlas copies.

It is not stable yet. Current state: locally ready, remediation patterns proven.

Remaining gates:

1. Stop adding more copy-only remediation for this phase.
2. Keep test files in scope, but do not count test-only findings as production drift replication.
3. Rerun the broad inventory after any real consumer cleanup and confirm no new false-positive category appears.
4. Keep `stable: false` until the registry has no unresolved productionization concerns.
