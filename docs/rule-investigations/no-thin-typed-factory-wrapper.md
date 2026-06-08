# no-thin-typed-factory-wrapper Investigation

Working names:

- `antidrift/no-thin-typed-factory-wrapper`
- `antidrift/no-unearned-return-contract`
- `antidrift/no-redundant-typed-delegation`

Status: `research`. Do not implement or enable until real-corpus evidence shows this can stay narrow.

Correction from the first investigation pass: Codebase Atlas does contain production candidates for the broader pattern. They are not exact-forward wrappers; they are typed local-constructor wrappers that pass derived string/template arguments to another local factory. That means the exact-forward-only rule would miss the user's motivating shape.

## Problem Statement

The suspected smell is an internal helper that appears to "make" a domain or contract value, but only delegates to another function and repeats a named return type:

```ts
function buildRoute(
  path: string,
  title: string,
  visible: boolean,
): WebviewRoute {
  return makeRoute(path, title, visible);
}
```

This is concerning only when `makeRoute` already returns `WebviewRoute` or a TypeScript-assignable equivalent. In that case the wrapper's explicit return annotation does not validate, transform, brand, narrow, add defaults, or establish boundary context. It is a type contract written on a function that did not earn that contract.

This is not the same as banning functions whose body is one returned call. Real projects use that shape for facades, package boundaries, class adapters, branded constructors, schema validators, method binding, and semantic names.

## Proposed Narrow Signal

The safest signal is TypeChecker-backed exact-forward delegation, but Codebase Atlas shows that the motivating pattern is broader than exact-forward.

A narrow exact-forward report would require all of these:

1. The function is internal, not exported and not a public member of an exported class.
2. The function has an explicit return type annotation.
3. The return annotation is a named domain/contract type, or a wrapper around one such as `Promise<WebviewRoute>`.
4. The body is exactly one returned call expression.
5. The call forwards every parameter verbatim, in order, with no extra arguments, omitted arguments, spreads, literals, defaults, object construction, or property reads.
6. TypeScript proves the call's return type is the same as, or mutually assignable with, the annotated return contract after unwrapping async/Promise where appropriate.
7. The call is not a validator, parser, brand constructor, assertion function, or other configured contract-earning boundary.

The broader research branch is typed local-constructor delegation:

1. The function is internal and has an explicit named return contract.
2. The body is exactly one returned call expression.
3. The callee is a local helper/factory whose call return type is the same named contract.
4. Arguments are only parameters, property reads from parameters, literals, arrays/objects of those, and deterministic string/template derivations.
5. The wrapper adds no validation, narrowing, error context, branching, side effects, caching, instrumentation, or boundary context.

If the wrapper is still useful for semantic naming, the likely fix is to keep the wrapper and remove the explicit return annotation. If the wrapper has no semantic value, inline the delegated call.

## Ecosystem Check

No supported equivalent was found for this exact behavior.

Adjacent rules are not enough:

- ESLint `no-useless-return` only removes redundant `return;` statements with no value; returning a call is explicitly allowed by that rule.
- `@typescript-eslint/no-unsafe-return` catches returning `any`/`any[]`/`Promise<any>`, not redundant delegation from a typed callee.
- `@typescript-eslint/explicit-function-return-type` enforces the opposite style policy. Its docs explicitly note that inferred return types are often enough, but it does not decide when an annotation is unearned.
- SonarJS has nearby maintainability rules such as `prefer-immediate-return`, but those target local variables that are immediately returned, not typed factory wrappers.
- TypeScript's own inference already determines function return types from `return` statements, which is the language behavior this candidate would lean on.

The implementation host, if this is ever promoted, should be `typescript-eslint` custom rules with parser services. `typescript-eslint` documents typed linting as the path for rules that need TypeScript's type checking APIs, and this candidate depends on symbol identity and assignability.

Sources checked:

- https://eslint.org/docs/latest/rules/no-useless-return
- https://typescript-eslint.io/rules/no-unsafe-return/
- https://typescript-eslint.io/rules/explicit-function-return-type/
- https://typescript-eslint.io/getting-started/typed-linting
- https://typescript-eslint.io/developers/custom-rules/
- https://github.com/SonarSource/eslint-plugin-sonarjs
- https://www.typescriptlang.org/docs/handbook/type-inference.html

## Test Matrix

These are real-program shapes to validate before implementation. Reduced programs are allowed only after the real anchors exist.

| Case | Example shape | Expected | Why |
| --- | --- | --- | --- |
| Internal exact-forward factory | `function buildRoute(a, b): WebviewRoute { return makeRoute(a, b); }`, and `makeRoute` returns `WebviewRoute` | Flag | The wrapper repeats a contract already supplied by the callee and earns no new type authority. |
| Internal exact-forward to structurally equivalent object | `function buildRoute(a): WebviewRoute { return makeRouteObject(a); }`, and the call type is mutually assignable with `WebviewRoute` | Research flag | This is the interesting laundering case, but it may overlap intentional facade/projection patterns. Needs real evidence. |
| Internal templated constructor wrapper | `function renderSprite(id: string): VisualTokenRegistryEntry { return entry(\`render.sprite.${id}\`, ["render.sprite"], [\`sprite.${id}\`], "..."); }` | Research flag | Codebase Atlas has this shape. It may be real drift or a useful abstraction; classify before implementation. |
| Internal typed classification wrapper | `function classificationForFile(file): ClassificationInput { return classification(...derived values...); }` | Research flag | Codebase Atlas has this shape. The callee already returns the annotated contract, but the wrapper names a domain fact. |
| Property extraction into conversion helper | `function terrainNodeIdForGameNode(node): TerrainNodeId { return terrainNodeIdForGameNodeId(node.id); }` | Research/likely allow | The callee validates/converts the ID. This may be a useful adapter rather than unearned contract. |
| Same wrapper without return annotation | `function buildRoute(a, b) { return makeRoute(a, b); }` | Allow | Inference is doing the work; no explicit contract is being laundered. |
| Exported package facade | `export function reload(id): Promise<Project> { return readProject(id); }` | Allow | Exported functions are boundaries. A package API may intentionally name or stabilize the callee. |
| Public method on exported class | `export class Store { read(id): Promise<Project> { return this.inner.read(id); } }` | Allow | Public members are API surface. Thin delegation can be a facade contract. |
| Private member exact-forward | `private read(id): Promise<Project> { return readProject(id); }` | Research flag | Internal, but private class facades are common. Needs corpus evidence before enabling. |
| Member-expression callee | `function valid(repo): Promise<boolean> { return this.git.isValidRepo(repo); }` | Probably allow initially | Service facades and method binding produce many false positives. Identifier-only callees may be the safer first scope. |
| Defaulting or constants | `return makeRoute(path, title, visible ?? true)` | Allow for exact-forward; research for typed-constructor wrappers | The wrapper changes input semantics. Codebase Atlas shows deterministic constructor arguments may still be worth investigating, but not under the exact-forward rule. |
| Object construction | `return makeRoute({ path, title, visible })` | Allow | Construction changes the call contract even if shallow. |
| Validation boundary | `return WebviewRouteSchema.parse(raw)` | Allow | Parser/validator earns the contract. |
| Brand construction | `return WebviewRouteId.make(raw)` or `Schema.parse(\`route-${id}\`)` | Allow | Branding is exactly how a contract is earned. |
| Transformation after call | `return makeRoute(a).withTitle(title)` | Allow | The wrapper transforms the result. |
| Error context | `try { return makeRoute(a); } catch (error) { throw new RouteError(error); }` | Allow | Error translation is behavior. |
| Metrics/cache/logging | `return cache.getOrSet(key, () => makeRoute(a))` | Allow | The wrapper adds behavior and usually does not forward params exactly. |
| Overload implementation | overload signatures plus body returning a call | Allow initially | Overloads are declaration contracts; reporting them would likely be noisy. |
| Generic preservation | `function wrap<T>(input: T): Result<T> { return result(input); }` | Research | Generic relationships can be real type modeling, not type laundering. |
| Async promise wrapper | `async function load(id): Promise<Project> { return readProject(id); }` | Research | `return await` and async context interact with stack traces/error behavior. Do not report until modeled. |
| Generated client wrapper | `function getUser(id): Promise<User> { return client.getUser(id); }` | Allow by path/config | Generated/client facades are stable boundary code, not drift evidence. |

## Real-Corpus Scan Notes

A syntax-only inventory of typed single-return-call functions across Codebase Atlas, Murderbox, Sudocode, and Cloudflare Agents produced many legitimate wrappers. A TypeScript-program scan of Codebase Atlas then found production candidates for the broader local-constructor-wrapper shape.

Codebase Atlas candidate anchors:

- `/Users/sushi/code/codebase-atlas/src/visualTokens/visualTokenRegistry.ts` lines 142-148: `renderSprite(spriteId: string): VisualTokenRegistryEntry` returns `entry(...)`, and TypeScript proves `entry(...)` already returns `VisualTokenRegistryEntry`. The wrapper derives deterministic token strings and rationale text.
- `/Users/sushi/code/codebase-atlas/src/programs/repoIngestion.ts` lines 1736-1749: `classificationForFile(file: ParsedRepoSourceFile): ClassificationInput` returns `classification(...)`, and the callee already returns `ClassificationInput`.
- `/Users/sushi/code/codebase-atlas/src/programs/repoIngestion.ts` lines 1843-1852: `classificationForConfigFile(file: ParsedRepoSourceFile): ClassificationInput` returns `classification(...)`, and the callee already returns `ClassificationInput`.

Codebase Atlas disputed/likely clean controls:

- `/Users/sushi/code/codebase-atlas/src/services/sceneStateAdapter.ts` lines 322-327: `terrainNodeIdForGameNode` and `terrainNodeIdForSceneInstance` return a conversion helper call over a property. The underlying helper validates the `game-` prefix and parses the branded terrain ID, so this may earn the contract indirectly.
- `/Users/sushi/code/codebase-atlas/src/parsing/treeSitterRealProgramParser.ts` lines 797-860: the `required*` helpers return `required(...)` with contextual error messages. The wrapper adds error context and should stay clean.
- `/Users/sushi/code/codebase-atlas/src/services/atlasIdService.ts` lines 20-53: exported branded ID constructors call schema `.parse(...)` on constructed strings. These must stay clean.
- `/Users/sushi/code/codebase-atlas/src/programs/lanternController.ts` lines 48-59: `markExplorationTileUnderstood` returns `ExplorationStateSchema.parse(...)` after transforming nested state. This must stay clean.
- `/Users/sushi/code/codebase-atlas/src/programs/persistenceCuration.ts` lines 198-202: `reloadPersistedProject` is an exported exact-forward package/program facade. This must stay clean.
- `/Users/sushi/code/murderbox/apps/client/src/lib/storage.ts` lines 28-37: exported storage/secret facades exactly forward to local storage helpers. These are boundary names and should stay clean unless a consumer opts into stricter facade pruning.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/service-stop-router.ts` lines 182-205: `buildRouteAssignmentStop` constructs a real route-assignment object. Not a call wrapper.
- `/Users/sushi/code/chaski/src/frontend/portal/proxy.ts` lines 12-17: `isWebviewRoute` is a boolean route predicate. It belongs to predicate/control-flow review, not this rule.

Potential future drift anchors still needed:

- Classification of the Codebase Atlas candidates above as accepted drift or accepted clean abstractions.
- A second independent repository with the same accepted drift shape.
- A real remediation where removing the annotation or wrapper improves the code without losing API meaning.

## Public Corpus Candidates

Use these as validation candidates, not as fixture sources:

- Zod-heavy libraries for schema/factory boundaries: `colinhacks/zod`, `ecyrbe/zodios`, `BenLorantfy/nestjs-zod`, `RobinTail/express-zod-api`, `mattpocock/zod-fetch`.
- ESLint-plugin codebases for facade/control rules: `eslint-community/eslint-plugin-eslint-plugin`, `vitest-dev/eslint-plugin-vitest`, `un-ts/eslint-plugin-import-x`, `javierbrea/eslint-plugin-boundaries`.
- Oxlint-adjacent TypeScript projects for migration/facade controls: `oxc-project/eslint-plugin-oxlint`, `oxc-project/oxlint-migrate`.

ESLint, Oxlint, and typescript-eslint repositories are useful clean controls for rule-authoring and facade patterns. They are not automatically evidence that this rule is useful in product code.

## False-Positive Risks

Stack-ranked:

1. Intentional facades. Package APIs, service adapters, and class methods often exact-forward by design.
2. Boundary naming. A wrapper may name a domain use case even when it delegates today.
3. Validation and branding. Schema `.parse(...)` and brand constructors are single returned calls but are the correct construction pattern.
4. Structural projection. A function may intentionally hide extra fields behind a named return type; TypeScript does not project at runtime, but the source-level intent may be API simplification.
5. Method binding. `this.inner.method(x)` wrappers can preserve receiver/context or isolate dependencies.
6. Async/error behavior. `async` wrappers and `return await` can affect error stacks and try/catch behavior.
7. Generated or framework glue. Thin wrappers are common and often useful in generated clients, route loaders, RPC adapters, and test harnesses.

## False-Negative Risks

Likely escape shapes:

- Add a temporary variable and return it. SonarJS `prefer-immediate-return` may catch some of these, but it is not equivalent.
- Add a no-op transform, such as spreading the result or forwarding `...args`.
- Reorder through an object `{ path, title, visible }`.
- Export the wrapper to hit the boundary exemption.
- Delegate through a member expression if the first implementation excludes member callees for noise control.
- Use `satisfies` or a local variable annotation instead of a function return annotation.

## Promotion Gate

Keep this candidate in `research` until all of these are true:

1. Codebase Atlas candidates are classified as accepted drift or accepted clean abstractions.
2. At least two independent repositories contain accepted real non-test drift anchors that were not added to satisfy the rule.
3. A broad inventory over Chaski, Codebase Atlas, Murderbox, Sudocode, and at least two public corpus candidates shows zero known false positives under the chosen signal.
4. Clean controls for validators, brand constructors, facades, member-call adapters, async wrappers, contextual-error helpers, and exported boundaries are explicitly recorded.
5. Claude Opus 4.8 advisory review reads the current repo and this doc, then writes a non-empty report under `reports/`.
6. The first implementation, if approved, starts default-off or non-blocking until a real remediation proves the rule's action is useful.

## Advisory Review

Claude Opus 4.8 advisory completed on 2026-06-08:

- `reports/claude-thin-typed-factory-review-20260608-122821.md`
- `reports/claude-thin-typed-factory-review-20260608-122821.debug.log`

The debug log shows `Read` and `Grep` tool use against the repository. The advisory agreed with the pre-correction status: keep the candidate in `research`, do not implement on zero accepted drift anchors, and avoid the broad "single returned call" rule. It also recommends that a first implementation, if evidence later justifies one, start with symbol-identity or very narrow assignability rather than broad structural equivalence. Rerun advisory review before promotion because the Codebase Atlas candidate anchors were added after this report.

## Current Verdict

Do not implement the broad "single returned call" version.

The exact-forward-only rule is too narrow for the motivating Codebase Atlas examples. The plausible custom rule is now a TypeChecker-backed internal typed-constructor-wrapper rule with strict clean controls for validators, brands, exported facades, contextual error helpers, and conversion helpers. It still stays in `research` until the Codebase Atlas candidates are classified and a second independent repository replicates the accepted drift shape.

Before implementing, verify the accepted drift is not already covered by:

- `antidrift/no-trivial-selector-wrapper`
- `antidrift/no-redundant-zod-parse`
- `antidrift/no-appeasement-cast`
- `antidrift/no-underchecked-type-predicate`
- `@typescript-eslint/no-unsafe-return`
- SonarJS immediate-return/no-identical implementation rules
