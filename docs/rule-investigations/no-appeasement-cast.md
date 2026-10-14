# no-appeasement-cast Investigation

## Current Rule

`antidrift/no-appeasement-cast` is exported and enabled at `error` in the typed ESLint configuration. Its registry status is `ready`, with `stable: false`.

The rule is type-aware. It visits `as` and angle-bracket casts and every import site, and derives each cast decision from `CAST_DECISION_TABLE` in `tooling/antidrift/src/semantic-adapters/cast-proof.mjs`. The first matching row decides:

| Row | Kind                                | Decision   | Reason                                                                                                                                                                                                                                                                                                                                                              |
| --: | ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | `const_assertion`                   | clear      | `as const` asks TypeScript for the operand's own literal type and asserts no contract.                                                                                                                                                                                                                                                                              |
|   2 | `non_narrowing_target`              | clear      | The target is `any` or `unknown` and claims nothing beyond the source, whatever the source's provenance.                                                                                                                                                                                                                                                            |
|   3 | `double_cast_chain`                 | clear      | A nested assertion chain belongs to `no-unsafe-cast-chain`.                                                                                                                                                                                                                                                                                                         |
|   4 | `type_predicate_implementation`     | clear      | A type predicate or assertion function that inspects its own parameter implements the boundary that proves the type.                                                                                                                                                                                                                                               |
|   5 | `unresolved_source_type`            | incomplete | The operand's type provenance reaches a module or name the program cannot resolve, a shorthand ambient module (`declare module "x";` without a body, whose exports are all `any`), or a compiler error type. Whether the operand is broad is undecidable.                                                                                                              |
|   6 | `typed_source`                      | clear      | The operand's declared type, before control-flow narrowing, is neither `any`, `unknown` nor a type parameter whose base constraint is one of them. The cast does not force a broad value, whatever its target.                                                                                                                                                       |
|   7 | `unresolved_target_type`            | incomplete | The target type's provenance reaches a module or name the program cannot resolve, a shorthand ambient module, or a compiler error type, so the claimed contract is unknown.                                                                                                                                                                                         |
|   8 | `unstable_narrowing_proof`          | incomplete | TypeScript narrowed the value to a type that proves the target, but between the establishing test and the cast a call, `await`, `yield`, member write or closure assignment that TypeScript's narrowing ignores may change the value. The diagnostic names the disrupting expression and its kind.                                                                   |
|   9 | `checker_narrowing_proof`           | clear      | A checker-visible proof (type predicate branch, `asserts` call, `instanceof`, `typeof`, discriminant or a decoder's typed result) narrowed the value to the target itself or to a type assignable to it in which no `any` at any depth stands in for a concrete part of the target. A value narrowed to an object satisfies a target that only claims unknown-valued keys, such as `Record<string, unknown>`. |
|  10 | `unresolved_proof_candidate`        | incomplete | An expression that tests this value before the cast (a call, `instanceof` or comparison) depends on a module or name the program cannot resolve, so a proof TypeScript cannot see may exist.                                                                                                                                                                      |
|  11 | `broad_source_to_unproven_contract` | report     | An `any` or `unknown` value is cast to a contract that no checker-visible proof establishes.                                                                                                                                                                                                                                                                        |

A proof counts only when TypeScript itself narrows the cast operand. An `expect(...)` matcher, a `Map.has` check, a function named `assert` without an `asserts` signature, an ignored predicate call or a discarded decoder call does not narrow the value, so the cast reports. A narrowing that does not reach the target also reports, such as `unknown` narrowed to `object`, `{}`, `string` or `any[]` and then cast to a named contract. Identity is checked first: a flow type that is the target, or the same generic reference with pairwise identical arguments, proves it. Otherwise assignability counts only when no `any` anywhere in the flow type (type arguments, properties, index signatures, array elements, at any depth) is what makes a concrete part of the target admissible, so `{ id: any }` does not prove `{ id: string }`, `any[]` does not prove `string[]`, and `Map<any, any>` does not prove `Map<string, Contract>`. `Array.isArray` proves `unknown[]` but not `string[]`, and an object narrowing never proves an array target. An unconstrained type parameter is as broad as `unknown`.

Type provenance is followed without a depth limit and without a dependency-path exception. The walk follows declarations, inferred returns of block-bodied functions, `for...of` sources, and the contextual call, JSX element or annotated declaration that types an unannotated callback parameter. A declared type annotation is conclusive: a parameter or variable annotated `unknown`, `any` or any other type takes its type from the annotation, so the walk does not enter its initializer, and an `as T` initializer is conclusive in the same way, so the walk follows `T` and not the asserted operand. Only declarations in TypeScript's default library are skipped, because the program owns them. A module counts as resolved only when the owning program's checker returns a module symbol for the specifier and that symbol has a body: a shorthand ambient module (`declare module "untyped";` or `declare module "*.raw";` without braces) types every import from it as `any`, so a cast whose type depends on such an import is incomplete and names the module, while a pattern module with a body stays a resolved, typed source. The source side (row 5) and the target side (row 7) are walked separately, so a typed operand clears before an unresolved target is considered, and a cast to `any` or `unknown` clears before either side is walked.

Every static, dynamic, side-effect, re-export, `import x = require()` and `import()` type site whose module the checker cannot resolve gets its own incomplete-analysis diagnostic, whether or not the file contains a cast. A computed `import()` specifier is unresolvable by definition.

Files whose leading comment block (before the first code token) declares the file generated are skipped. The declaration forms live in `tooling/antidrift/src/semantic-adapters/generated-source.mjs`, and the corpus scan driver imports the same owner: a line starting with `@generated`; a do-not-edit or do-not-modify notice, case-insensitive; `this file`/`this code` `is`/`was`/`has been` ... `generated`; a line starting with `generated by`/`from`/`with`/`using`; or the word `auto-generated`/`autogenerated`. Prose that merely uses the word (a test's doc comment saying a tool "generated a fresh thread id") does not match. Test files receive no exemption: a cast of test output is reported unless an earlier assertion in the same flow narrows the value checker-visibly.

Known limits: for a plain local binding the rule trusts TypeScript's narrowing, except when a nested function may reassign the binding. A write into the proved object's fields through another reference is not tracked. A member reference such as `holder.value` gets less trust. The establishing test is the latest test of the reference before the cast that governs it: the condition of an `if`, `while`, `do`, `for`, `switch` or conditional expression that encloses the cast, the condition of an early-exit guard (`if (!test) return` or `throw`, `break`, `continue`) in the cast's block, or an `asserts` call statement in that block. Between that test and the cast, a call that is not itself a type-predicate test of the value or of a prefix of its reference, an `await`, a `yield`, a `delete` or a same-named member write makes the proof incomplete. Code before the establishing test is not a disruption. A narrowing established only by a loop's exit condition has no establishing test, so the window starts at the function body.

## Ecosystem Check

Closest supported rule:

- `@typescript-eslint/no-unsafe-type-assertion`

That upstream rule is real and high support. It catches some of the same bad assertions, but it is broader than the antidrift rule. In Chaski, the upstream rule also reports typed SDK/API conversion patterns that this package currently treats as clean controls because their source value is already typed. So the ecosystem rule is not an equivalent replacement for this project scope.

## Upstream Delta Benchmark

Run:

```bash
pnpm policy:benchmark-unsafe-type-assertion
```

The benchmark runs `@typescript-eslint/no-unsafe-type-assertion` beside `antidrift/no-appeasement-cast` over real Chaski, Codebase Atlas, and Sudocode TypeScript programs. An earlier source scan checked 2,585 files, with 274 parser errors recorded separately, and produced:

| Rule                                          | Findings |
| --------------------------------------------- | -------: |
| `antidrift/no-appeasement-cast`               |      101 |
| `@typescript-eslint/no-unsafe-type-assertion` |    1,619 |

Location comparison:

| Result                                                        | Count |
| ------------------------------------------------------------- | ----: |
| Locations reported by both upstream and `no-appeasement-cast` |   100 |
| Upstream-only locations                                       | 1,517 |
| Antidrift-only locations                                      |     0 |

Interpretation: upstream is a strict superset on the measured corpus, but too broad to replace this custom rule as the targeted broad-input authority policy. Keep this rule default-on for the narrow `any`/`unknown` source-type contract and use the upstream rule as the maintained broad assertion benchmark.

## Real Corpus Evidence

### Drift

Chaski:

- `chaski/src/frontend/portal/api/apiService.ts` line 81 casts an unknown caught error to `AxiosError` only to read `response.status`.

Expected repair:

```ts
if (axios.isAxiosError(err)) {
  const statusCode = err.response?.status;
}
```

Codebase Atlas:

- `codebase-atlas/src/needle/AtlasNeedleRenderer.ts` line 205 casts `mesh.userData.baseEmissive` to `ThreeColor`.
- `codebase-atlas/src/programs/persistenceCuration.ts` line 1269 casts broad input to `TerrainLayoutAnchor` before checking fields.

Expected repair:

```ts
const baseEmissive = mesh.userData.baseEmissive;
if (baseEmissive instanceof this.THREE.Color) {
  material.emissive.copy(baseEmissive);
}
```

### Clean Controls

Chaski:

- `chaski/src/frontend/portal/lib/firebase/server.ts` converts `currentUser.toJSON()` to Firebase `User`. This stays clean because the source is typed, not because the rule has an SDK/API allowlist.

Codebase Atlas adjacent clean pressure:

- `codebase-atlas/src/programs/persistenceCuration.ts` has `isTerrainLayoutAnchor` as a legitimate predicate shape once it checks through a guard or delegates to the owning schema. The current live repo implementation is still flagged because it casts before checking.
- `codebase-atlas/src/bridge/AtlasSceneBridge.ts` casts a typed DOM `Event` to `CustomEvent<AtlasSceneEvent>` and stays clean because the source is not `any` or `unknown`.

## Remediation Evidence (2026-06-04)

Four production repairs have been applied in bracket-prefixed copies so the live repos are not modified:

```bash
pnpm policy:validate-appeasement-remediation
```

| Repo                | File                                                                                                    | Old pattern                                                                 | Repair                                                                                                                             | Validation                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaski copy         | `[antidrift-no-appeasement-remediation]-chaski/src/frontend/portal/api/apiService.ts`                   | `err as AxiosError` on a caught `unknown`                                   | `isAxiosError(err)` guard before reading `response.status`                                                                         | `policy:validate-appeasement-remediation` passes; the copied file is a clean case.                                                            |
| Chaski copy         | `[antidrift-no-appeasement-remediation]-chaski/src/frontend/portal/components/ImpersonationWarning.tsx` | Three `JSON.parse(...) as ImpersonationData` storage casts                  | `parseStoredImpersonationData` parses into `unknown` and checks optional string/number fields before returning `ImpersonationData` | `policy:validate-appeasement-remediation` passes; the copied file is a clean case for serialized browser storage.                             |
| Codebase Atlas copy | `[antidrift-no-appeasement-remediation]-codebase-atlas/src/programs/persistenceCuration.ts`             | `value as TerrainLayoutAnchor` before checking fields                       | `TerrainLayoutAnchorSchema.safeParse(value).success`                                                                               | `policy:validate-appeasement-remediation` passes; the copied file is a clean case while `AtlasNeedleRenderer.ts` still proves adjacent drift. |
| Codebase Atlas copy | `[antidrift-no-appeasement-remediation]-codebase-atlas/src/needle/AtlasNeedleRenderer.ts`               | `mesh.userData.baseEmissive as ThreeColor` from a third-party user-data bag | `baseEmissive instanceof this.THREE.Color` guard before copying into the material                                                  | `policy:validate-appeasement-remediation` passes; the copied file is a clean case for third-party bag narrowing.                              |

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
- Named array aliases or collection contracts may resolve to non-empty object-like targets and need real-corpus classification before broad claims.

## False-Negative Risks

- If a broad value is first assigned to a precise local type and then cast later, the rule may miss the original laundering site.
- A bad cast hidden behind a generic helper can appear as a typed source at the assertion site.

## Promotion State

This remains a strong promotion candidate because it has real drift replication in Chaski, Codebase Atlas, and Sudocode, plus remediation-pattern evidence in bracket-prefixed Chaski and Codebase Atlas copies.

It is not stable yet. Current state: ready, default-on, remediation patterns proven.

Remaining gates:

1. Stop adding more copy-only remediation for this phase.
2. Keep test files in scope, and require runtime assertions before test-output casts.
3. Rerun the broad inventory after any real consumer cleanup and confirm no new false-positive category appears.
4. Keep `stable: false` until the registry has no unresolved productionization concerns.

## Superseded round 5 measurement on October 13, 2026: no-appeasement-cast

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 5695 hits in 37 repositories. The new rule reports 12042 hits in 37 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 19 true, for 95% precision. Labels freeze before scoring.

- Label file: `new-no-appeasement-cast.labels.tsv`. SHA256: `22499c2e4221e7994a57f04947be5a5443d067ff10d86fc612c9342783edd898`. Frozen at 2026-10-13T07:14:23.635701+00:00.
- Label file: `dropped-no-appeasement-cast.labels.tsv`. SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Frozen at 2026-10-13T07:15:30.228681+00:00.

## Superseded round 6 sample before runtime proof

The owner assigns inline `as unknown as T` chains to `no-unsafe-cast-chain`. This rule skips those chains again. Other casts keep their existing scope. The fresh sample scores lower than round 5. Error types and casts used within typed adapters still cause false reports.

The same 39 installed repositories contain 12,042 reports before this change and 5,695 after it. The new rule reports in 37 repositories. A fresh round-robin sample with seed 2026101303 excludes all earlier sampled locations. Source review labels 10/20 true (50%). Labels freeze before scoring.

- New labels: `new-no-appeasement-cast.labels.tsv`. SHA256: `68fd8abaa3e2de5d0bf84e64e2870e31616249391d8c2990dd8a95a00595aaf6`. Frozen at 2026-10-13T13:55:03.146707+00:00.
- Dropped labels: `dropped-no-appeasement-cast.labels.tsv`. SHA256: `4385eb9cf7d6c866acbcb372185c2f618cd4bd48fc36e53bc5e5f168189155ef`. Frozen at 2026-10-13T14:08:46.899443+00:00.

## Superseded round 6 runtime proof measurement

The rule skips preceding runtime checks that prove the target when TypeScript cannot narrow from those checks. The 20 hits come from 13 repositories (seed 2026101308). Nine hits are true violations, nine inspect values produced by tests, and two are false positives (a proven `DOMException` whose expression contains a non-null assertion, and a string-literal union `QueryScope`).

- New labels: `new-no-appeasement-cast.labels.tsv`. SHA256: `1967e1cec9f893c4ca5d6056948d36cbd9ec840dd9af8f6416fa3d142e137680`. Frozen at 2026-10-13T17:13:45.396832+00:00.
- Dropped labels: `dropped-no-appeasement-cast.labels.tsv`. SHA256: `8fcb2ec6bf3495a338dbf3ef5ba1d877fe593046683a4b084d5784ecfa3a3bcc`. Frozen at 2026-10-13T17:14:17.407091+00:00.

## Superseded round 1 measurement on October 14, 2026: no-appeasement-cast

Across the 59-repository combined corpus (`oss-corpus` 39 repositories + `oss-corpus-agents` 20 repositories), 58 repositories completed with 0 fatal parser errors (`oss-corpus`: 39/39 scanned, 3,518 hits; `oss-corpus-agents`: 19/20 scanned, 474 hits). A hit-weighted sample of 24 hits scored 23/24 (95.83%), with label file `new-no-appeasement-cast.labels.tsv` (`SHA256: b9989dc316ccd983af9e105b40a8fef64b6a7d66469b3ed7e4d1661e57011f80`, frozen at `2026-10-14T01:03:00.361542+00:00`). Superseded after review identified population exclusions (`B1`), unresolved module/identifier precedence (`H1`), syntax-based target filtering (`H2`/`H3`), and unverified predicate/decoder/brand exemptions (`H4`/`H5`/`M1`).

## Superseded round 2 measurement on October 14, 2026

The round 2 scan selected 59 repositories from earlier install receipts instead of inventorying both corpus roots. It omitted six repositories that track 3,311 TypeScript files (`colinhacks-zod`, `herdrdev-herdr`, `ianstormtaylor-superstruct`, `nestjs-nest`, `react-hook-form-resolvers`, `py-wandb-weave`). Within the 59, 6 tracked files went unanalysed: four failed to parse, and ESLint's default `node_modules` ignore skipped two. The receipts report 15,813 hits and 44,942 incomplete-analysis sites. The unit labels scored 23/24 (labels `round2/new-no-appeasement-cast.labels.tsv`, SHA256 `c10bf4ba2b41d04a4a4515aab28e4ee496df7f367d058cce4450e98257196dce`). An independent review scored the same sample 22/24, because two sampled hits came from unresolved contextual imports. The review also found three gaps: unresolved contextual imports reported as violations, depth and dependency-path limits treated as resolved, and assertions recognised by name. It also found a proved value whose mutation before the cast still cleared. Round 3 supersedes this measurement.
