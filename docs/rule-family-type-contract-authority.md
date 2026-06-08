# Type Contract Authority Rule Family

This family owns the project question: when does local code have the right to claim a TypeScript contract?

The accepted construction paths are import, inference, validation, narrowing, branding, or derivation from the owning module. The rejected path is local appeasement: writing a type annotation, cast, predicate, parse, wrapper, or duplicate shape that makes TypeScript accept a contract the code has not actually earned.

This is a family registry, not an implementation queue. A subset can be stable, ready, under-proven, research, ecosystem-covered, or retired. Research and retired subsets document boundaries so future work does not broaden a good rule into a noisy one.

## Family Subsets

| Subset | Owning rules | State | Strongest signal | What it flags | What stays clean |
| --- | --- | --- | --- | --- | --- |
| Selector inference appeasement | `antidrift/no-trivial-selector-wrapper` | Stable | AST structural return shape | Internal helpers that only return a member of their own parameter while adding an explicit return contract. | Exported boundaries, public API methods, transformed selectors, and inferred helpers. |
| Type escape casts | `antidrift/no-appeasement-cast`, `antidrift/no-unsafe-cast-chain`, `antidrift/no-cast-to-branded` | Ready plus under-proven brand subset | TypeChecker plus cast syntax | `any`/`unknown` or double-cast paths into named contracts; future brand-specific casts if evidence appears. | Guards, schema parses, brand constructors, and typed SDK conversions whose source is not `any` or `unknown`. |
| Validation-boundary provenance | `antidrift/no-unsafe-deserialize`, `antidrift/no-redundant-zod-parse`, research `antidrift/no-same-schema-recertification` | Stable plus research stub | TypeChecker plus schema/string boundary provenance | `JSON.parse` on broad input and re-parsing values already typed as the same schema output. | First-boundary parsing of raw input, schema-contract assertions, and invariant checkpoints with real evidence. |
| Broad shape probing | `antidrift/no-underchecked-type-predicate`, `antidrift/no-defensive-shape-probing` | Ready | TypeChecker plus AST/control-flow checks | Predicates or normalizers that probe a token shape while claiming a larger object contract. | Field-complete guards, schema delegation, primitive predicates, typed union discriminants, and typed maps. |
| Contract shape duplication | `antidrift/no-structural-type-fork`, `antidrift/no-canonical-model-fork`, `antidrift/no-inline-structural-type-at-use-site`, `antidrift/no-nullable-positional-tuple` | Ready | TypeChecker, registry facts, and deterministic AST | Local structural copies of owner types, exported inline object contracts, and ambiguous nullable positional tuples. | Imported owner types, named DTO/input contracts, schema-inferred types, and named object ranges. |
| Typed delegation research | research `antidrift/no-thin-typed-factory-wrapper`, retired `antidrift/no-explicit-return-type-private-helper` | Research or retired | Exact-forward TypeChecker symbol identity, if ever revived | Only a future exact-forward wrapper that repeats the callee's return contract without adding behavior. | Domain constructors, classification helpers, validators, brand constructors, contextual error helpers, facades, and legitimate private return contracts. |

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
```

### Type Escape Casts

Flags:

```ts
const order = raw as Order;
const order = raw as unknown as Order;
const id = raw as UserId;
```

Allows:

```ts
const order = OrderSchema.parse(raw);

if (isOrder(raw)) {
  return raw;
}

const id = UserId.make(raw);
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
  (value) => hasNumber(value, "year") && hasNumber(value, "month") && hasNumber(value, "day"),
);

Object.entries(typedMap).map(([, value]) => value.name);
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
```

### Typed Delegation Research

Potential future flag, but not implemented:

```ts
function buildRoute(path: string, title: string): WebviewRoute {
  return makeRoute(path, title);
}
```

Allows:

```ts
function renderSprite(id: string): VisualTokenRegistryEntry {
  return entry(`render.sprite.${id}`, ["render.sprite"], [`sprite.${id}`], "sprite token");
}

function mapErrorCode(error: Error): TRPCError["code"] {
  return error instanceof AuthError ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR";
}
```

The broad "function whose only job is returning another function call" rule is out of scope. Real Codebase Atlas constructor/classification wrappers showed that shape can be good code.

## Non-Goals

- Do not use this family to ban explicit return types generally.
- Do not flag exported API facades just because they delegate.
- Do not treat schema `.parse(...)` as suspicious when it is the boundary that earns the contract.
- Do not turn research stubs into blocking rules without real drift and clean controls.
- Do not use AST shape as a proxy for intent when TypeChecker, registry, or scope evidence is required.

## Registry

The machine-readable registration lives in `policy/registries/rules.yaml` under `ruleFamilies.type-contract-authority`. `pnpm policy:check-registries` validates that every subset references known active, research, or retired rules and includes both flag and allow examples.
