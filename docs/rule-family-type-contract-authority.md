# Type Contract Authority Rule Family

This family owns the project question: when does local code have the right to claim a TypeScript contract?

The accepted construction paths are import, inference, validation, narrowing, branding, or derivation from the owning module. The rejected path is local appeasement: writing a type annotation, cast, predicate, parse, wrapper, or duplicate shape that makes TypeScript accept a contract the code has not actually earned.

This is a family registry, not an implementation queue. A subset can be stable, ready, under-proven, research, ecosystem-covered, or retired. Research and retired subsets document boundaries so future work does not broaden a good rule into a noisy one.

## Family Subsets

| Subset                            | Owning rules                                                                                                                                                          | State                                | Strongest signal                                                                | What it flags                                                                                                                                      | What stays clean                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selector inference appeasement    | `antidrift/no-trivial-selector-wrapper`                                                                                                                               | Stable                               | AST structural return shape                                                     | Internal helpers that only return a member of their own parameter while adding an explicit return contract.                                        | Exported boundaries, public API methods, transformed selectors, and inferred helpers.                                                                    |
| Type escape casts                 | `antidrift/no-appeasement-cast`; upstream `@typescript-eslint/no-unsafe-type-assertion` for broad/double assertions                                                   | Ready plus ecosystem coverage         | TypeChecker plus cast syntax                                                    | `any`/`unknown` paths into named contracts; broad unsafe assertions and double-cast tunnels are delegated to maintained ecosystem coverage.         | Guards, schema parses, brand constructors, and typed SDK conversions whose source is not `any` or `unknown`.                                             |
| Validation-boundary provenance    | `antidrift/no-unsafe-deserialize`, `antidrift/no-redundant-zod-parse`, research `antidrift/no-same-schema-recertification`                                            | Stable plus research stub            | TypeChecker plus schema/string boundary provenance                              | `JSON.parse` on broad input and re-parsing values already typed as the same schema output.                                                         | First-boundary parsing of raw input, schema-contract assertions, and invariant checkpoints with real evidence.                                           |
| Broad shape probing               | `antidrift/no-underchecked-type-predicate`, `antidrift/no-defensive-shape-probing`                                                                                    | Ready                                | TypeChecker plus AST/control-flow checks                                        | Predicates or normalizers that probe a token shape while claiming a larger object contract.                                                        | Field-complete guards, schema delegation, primitive predicates, typed union discriminants, and typed maps.                                               |
| Contract shape duplication        | `antidrift/no-structural-type-fork`, `antidrift/no-canonical-model-fork`, `antidrift/no-inline-structural-type-at-use-site`, `antidrift/no-nullable-positional-tuple` | Ready                                | TypeChecker, registry facts, and deterministic AST                              | Local structural copies of owner types, exported inline object contracts, and ambiguous nullable positional tuples.                                | Imported owner types, named DTO/input contracts, schema-inferred types, and named object ranges.                                                         |
| Typed delegation retired evidence | retired `antidrift/no-thin-typed-factory-wrapper`, retired `antidrift/no-explicit-return-type-private-helper`                                                         | Retired                              | Exact-forward TypeChecker symbol identity, only if reopened with new real drift | No active rule. Historical evidence covers a hypothetical exact-forward wrapper that repeats the callee's return contract without adding behavior. | Domain constructors, classification helpers, validators, brand constructors, contextual error helpers, facades, and legitimate private return contracts. |
| Brand-specific cast forgery       | retired `antidrift/no-cast-to-branded`                                                                                                                                | Retired                              | TypeChecker brand-marker proof, only if reopened with new real drift            | No active rule. Historical evidence covers direct casts into branded values, but no real non-test forgery or adopted marker evidence was found.    | Brand constructors, Zod parses, and general unsafe assertion coverage from maintained ecosystem rules.                                                   |

## Good Counterexample Matrix

These are examples that can look superficially similar to a violation. They should stay clean unless new real-corpus evidence proves otherwise.

| Subset                            | Good usage                                                                                                     | Why it is clean                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selector inference appeasement    | `export function selectSource(file: ParsedFile): string { return file.source; }`                               | Exported functions are API boundaries; their return type can be part of the public contract.                                                                                |
| Selector inference appeasement    | `const rowKey = (item: ChatItem): string => item.id;` when an external list API requires an annotated callback | The helper may be an adapter for an external API signature. Keep the helper only with a narrow rule-specific disable reason when the external annotation is truly required. |
| Type escape casts                 | `const user = currentUser.toJSON() as FirebaseUserJson;`                                                       | The source is a typed SDK value, not `any` or `unknown`; this is an interop conversion, not a broad-input type escape.                                                      |
| Type escape casts                 | `if (isOrder(raw)) return raw;`                                                                                | The predicate earns the type by narrowing before use. Predicate quality is owned by the predicate subset, not by cast rules.                                                |
| Type escape casts                 | `const id = UserId.make(raw);`                                                                                 | The brand constructor is the authority for creating the branded value.                                                                                                      |
| Validation-boundary provenance    | `const input = InputSchema.parse(JSON.parse(rawString));`                                                      | Raw string input is parsed and immediately validated at the boundary.                                                                                                       |
| Validation-boundary provenance    | `expect(() => RowSchema.parse(typedFixture)).not.toThrow();`                                                   | Schema-contract tests may intentionally assert that a typed fixture still satisfies the schema.                                                                             |
| Validation-boundary provenance    | `return moveTo(StateSchema.parse(nextState));`                                                                 | Invariant checkpoints can be valid when real code proves the parse establishes a state transition boundary.                                                                 |
| Broad shape probing               | `function isString(value: unknown): value is string { return typeof value === "string"; }`                     | Primitive predicates do not claim an object contract with unchecked fields.                                                                                                 |
| Broad shape probing               | `value.table === "orders" && value.data.type === "line-item"` over a typed union                               | Discriminant checks over already-typed unions are normal control flow, not broad-input laundering.                                                                          |
| Broad shape probing               | `Object.entries(typedMap).map(([, value]) => value.name)`                                                      | The map value already has an owned type, so property access is not defensive mini-parsing.                                                                                  |
| Contract shape duplication        | `type UserDto = z.infer<typeof UserDtoSchema>;`                                                                | The schema owns the wire contract; the type is derived from it instead of retyped manually.                                                                                 |
| Contract shape duplication        | `type DateRange = { start: Date \| null; end: Date \| null };`                                                 | Named fields carry meaning that a nullable positional tuple hides.                                                                                                          |
| Contract shape duplication        | `type ProjectWithTenant = Project & { tenantId: string };`                                                     | Supersets that add real fields are not structural forks of the owner type.                                                                                                  |
| Typed delegation retired evidence | `function renderSprite(id): VisualTokenRegistryEntry { return entry(...derivedTokenParts); }`                  | The wrapper derives domain facts and names a useful constructor. Broad single-call delegation would false-positive here.                                                    |
| Typed delegation retired evidence | `function requiredString(node): string { return required(node, "expected string"); }`                          | The wrapper adds contextual error meaning even if it delegates.                                                                                                             |
| Typed delegation retired evidence | `export function reloadProject(id): Promise<Project> { return readProject(id); }`                              | Exported facades can intentionally stabilize public package/API shape.                                                                                                      |

## Bad Usage Matrix

These examples show the behavior this family exists to reject. Bad examples in research subsets are evidence targets, not active lint behavior.

| Subset                            | Bad usage                                                                                                              | Why it is bad                                                                                                                                                                                            | Owning rule or state                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Selector inference appeasement    | `function fullExcerpt(file: ParsedFile): string { return file.source; }`                                               | The helper only repeats a property access while adding a return contract TypeScript can infer. Inline the member access or let the helper infer.                                                         | `antidrift/no-trivial-selector-wrapper`                                  |
| Selector inference appeasement    | `const itemId = (item: Item): string => item.id;`                                                                      | The annotation turns a bare selector into a local type assertion unless it is a documented external adapter boundary.                                                                                    | `antidrift/no-trivial-selector-wrapper`                                  |
| Type escape casts                 | `const err = caught as AxiosError;`                                                                                    | A caught value is broad input; use `axios.isAxiosError(caught)` or a local guard before reading Axios-specific fields.                                                                                   | `antidrift/no-appeasement-cast`                                          |
| Type escape casts                 | `const msg = JSON.parse(event.data as string) as OutgoingMessage;`                                                      | The input has crossed the string boundary, but the parsed output has not earned the named message contract. Validate or decode before claiming it.                                                       | `antidrift/no-appeasement-cast`                                          |
| Type escape casts                 | `const order = raw as unknown as Order;`                                                                               | The double cast tunnels through `unknown` to silence assignability instead of validating or narrowing.                                                                                                   | Ecosystem-covered by `@typescript-eslint/no-unsafe-type-assertion`       |
| Brand-specific cast forgery       | `const id = raw as UserId;`                                                                                            | A branded value should come from the brand constructor or schema parser; a cast forges the brand.                                                                                                        | Retired custom subset; reopen only with real non-test brand forgery      |
| Validation-boundary provenance    | `const input = JSON.parse(rawUnknown);`                                                                                | `JSON.parse` gives broad data. The boundary must guard the input string and validate the parsed payload before claiming a contract.                                                                      | `antidrift/no-unsafe-deserialize`                                        |
| Validation-boundary provenance    | `const row = RowSchema.parse(await getTypedRow());`                                                                    | Re-parsing a value already typed as the same schema output is usually certification theater; keep the parse at the raw boundary.                                                                         | `antidrift/no-redundant-zod-parse`                                       |
| Validation-boundary provenance    | `return StateSchema.parse({ ...state, changed });`                                                                     | A same-schema parse after local mutation may hide a missing typed state transition API. This stays research until real programs prove the boundary.                                                      | research `antidrift/no-same-schema-recertification`                      |
| Broad shape probing               | `z.custom<LineItem>((value) => typeof value === "object" && value !== null)`                                           | The predicate claims `LineItem` while checking only object-ness. It should validate required fields or delegate to a schema.                                                                             | `antidrift/no-underchecked-type-predicate`                               |
| Broad shape probing               | `Object.entries(raw as Record<string, unknown>).map(([, value]) => "numberValue" in value ? value.numberValue : null)` | This is a mini-parser over broad values; parse to an owned type once, then iterate typed data.                                                                                                           | `antidrift/no-defensive-shape-probing`                                   |
| Contract shape duplication        | `type UserFork = { id: string; email: string; status: UserStatus };`                                                   | A local structural copy can drift from the owner. Import the owner type or derive from the owner schema.                                                                                                 | `antidrift/no-structural-type-fork`, `antidrift/no-canonical-model-fork` |
| Contract shape duplication        | `export function load(input: { userId: string }) {}`                                                                   | Exported inline object contracts create unnamed boundary shapes that callers can duplicate. Name the input contract.                                                                                     | `antidrift/no-inline-structural-type-at-use-site`                        |
| Contract shape duplication        | `type CustomRange = [Date \| null, Date \| null];`                                                                     | Nullable positional tuples hide which slot means start/end and invite order bugs. Use a named object range.                                                                                              | `antidrift/no-nullable-positional-tuple`                                 |
| Typed delegation retired evidence | `function buildRoute(path: string, title: string): WebviewRoute { return makeRoute(path, title); }`                    | This is only suspicious if it is internal, exact-forwarding, adds no defaults/context/errors, and the callee already returns the same contract. No real non-test exact-forward drift was found.          | retired `antidrift/no-thin-typed-factory-wrapper`                        |
| Typed delegation retired evidence | `function routeForUser(userId: UserId): WebviewRoute { return makeUserRoute(userId); }`                                | A wrapper that only repeats another factory's contract can become a type appeasement layer in theory, but the audited corpus had no real anchor and broad variants false-positive on clean constructors. | retired `antidrift/no-thin-typed-factory-wrapper`                        |

## Examples

### Selector Inference Appeasement

Flags:

```ts
function fullExcerpt(file: ParsedFile): string {
  return file.source;
}
```

Allows:

```ts
function compactText(file: ParsedFile): string {
  return file.source.trim();
}

export function selectSource(file: ParsedFile): string {
  return file.source;
}

// eslint-disable-next-line antidrift/no-trivial-selector-wrapper -- external adapter type requires annotated callback
const rowKey = (item: ChatItem): string => item.id;
```

### Type Escape Casts

Flags:

```ts
const order = raw as Order;
```

`raw as unknown as Order` is covered by `@typescript-eslint/no-unsafe-type-assertion`, not by a separate custom rule. `raw as UserId` remains a bad construction pattern, but the custom brand-cast rule is retired until real non-test brand forgery evidence appears.

Allows:

```ts
const order = OrderSchema.parse(raw);

if (isOrder(raw)) {
  return raw;
}

const id = UserId.make(raw);

const user = currentUser.toJSON() as FirebaseUserJson;
```

### Validation-Boundary Provenance

Flags:

```ts
const input = JSON.parse(rawUnknown);
const row = RowSchema.parse(await getTypedRow());
return StateSchema.parse({ ...state, changed });
```

Allows:

```ts
const input = InputSchema.parse(JSON.parse(rawString));
const row = RowSchema.parse(rawRow);
return moveTo(StateSchema.parse(nextState));

expect(() => RowSchema.parse(typedFixture)).not.toThrow();
```

The same-schema state recertification example is research only. It is not an active rule until a real second-repo remediation proves the signal.

### Broad Shape Probing

Flags:

```ts
const LineItemSchema = z.custom<LineItem>(
  (value) => typeof value === "object" && value !== null,
);

Object.entries(raw as Record<string, unknown>).map(([, value]) =>
  "numberValue" in value ? value.numberValue : null,
);
```

Allows:

```ts
const DateMessageSchema = z.custom<DateMessage>(
  (value) =>
    hasNumber(value, "year") &&
    hasNumber(value, "month") &&
    hasNumber(value, "day"),
);

Object.entries(typedMap).map(([, value]) => value.name);

function isString(value: unknown): value is string {
  return typeof value === "string";
}
```

### Contract Shape Duplication

Flags:

```ts
type UserFork = {
  id: string;
  email: string;
  status: UserStatus;
};

export function load(input: { userId: string }) {}

type CustomRange = [Date | null, Date | null];
```

Allows:

```ts
import type { User } from "@agent-guardrails/domain";

export function load(input: LoadInput) {}

type DateRange = {
  start: Date | null;
  end: Date | null;
};

type UserDto = z.infer<typeof UserDtoSchema>;
```

### Typed Delegation Retired Evidence

Historical hypothetical flag, but retired and not implemented:

```ts
function buildRoute(path: string, title: string): WebviewRoute {
  return makeRoute(path, title);
}
```

Allows:

```ts
function renderSprite(id: string): VisualTokenRegistryEntry {
  return entry(
    `render.sprite.${id}`,
    ["render.sprite"],
    [`sprite.${id}`],
    "sprite token",
  );
}

function mapErrorCode(error: Error): TRPCError["code"] {
  return error instanceof AuthError ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR";
}

export function reloadProject(id: ProjectId): Promise<Project> {
  return readProject(id);
}
```

The broad "function whose only job is returning another function call" rule is out of scope. Real Codebase Atlas constructor/classification wrappers showed that shape can be good code.

The exact-forward slice is also retired. The read-only audit found no real non-test exact-forward internal drift, and exact-forward cases that did appear were exported facades excluded by the proposed boundary.

## Non-Goals

- Do not use this family to ban explicit return types generally.
- Do not flag exported API facades just because they delegate.
- Do not treat schema `.parse(...)` as suspicious when it is the boundary that earns the contract.
- Do not turn research stubs or retired evidence into blocking rules without real drift and clean controls.
- Do not use AST shape as a proxy for intent when TypeChecker, registry, or scope evidence is required.

## Registry

The machine-readable registration lives in `policy/registries/rules.yaml` under `ruleFamilies.type-contract-authority`. `pnpm policy:check-registries` validates that every subset references known active, research, or retired rules and includes both flag and allow examples.
