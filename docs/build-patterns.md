# Build Patterns

These patterns are the positive side of the guardrails. Lint rules catch drift after it appears; these recipes tell agents where a new concept belongs before they start writing code.

## Core Rule

Use **one owner per concept**.

A business concept should have one source module that owns its shape, vocabulary, predicates, and allowed transitions. Other layers import it, derive from it, or translate it at a boundary. They do not retype it locally.

## Pattern: Add A Domain Concept

Use this when adding a business thing such as `User`, `Project`, `Role`, `UserStatus`, or a domain predicate.

1. Add the owned type, literal set, and predicates in `packages/domain/src/<concept>.ts`.
2. Export it from `packages/domain/src/index.ts`.
3. Add or update ownership facts in `policy/registries/domain.yaml`.
4. Consumers import the domain type or literal set. They do not recreate the object shape or status union.

Example:

```ts
export const userStatuses = ["active", "disabled", "invited"] as const;
export type UserStatus = (typeof userStatuses)[number];

export type User = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
};
```

Do not add a local `AppUser`, `ApiUser`, or `'active' | 'disabled'` copy unless it is a real boundary translation with a distinct contract.

## Pattern: Add A Branded Value

Use this when a primitive must be validated before the domain can trust it, such as `UserId`, `TenantId`, `Email`, or a normalized external identifier.

1. Define the brand constructor next to the owning domain or contract concept.
2. Validate raw input with `brand(name, check)`, Zod, or another boundary validator.
3. Pass the branded value inward after validation.
4. Do not cast raw values into the brand.

Example:

```ts
import { brand, type Brand } from "@joedeleeuw/antidrift/brand";

export const UserId = brand("UserId", (value): value is string => typeof value === "string" && value.startsWith("user_"));
export type UserId = Brand<string, "UserId">;
```

Do not write `raw as UserId`; use `UserId.make(raw)`, `UserId.safe(raw)`, `UserId.is(raw)`, or a schema that produces the branded value.

## Pattern: Add A Contract Or Schema

Use this when adding request inputs, response DTOs, or validation schemas.

1. Put wire contracts in `packages/contracts/src/<feature>Contract.ts`.
2. Import domain primitives from `@agent-guardrails/domain` when the contract shares vocabulary with the domain.
3. Define validation with Zod and export `z.infer` types from the schema.
4. Validate raw input once at the API boundary, then pass the parsed value inward.

Example:

```ts
import { z } from "zod";
import { userStatuses } from "@agent-guardrails/domain";

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string().min(1),
  status: z.enum(userStatuses),
});

export type UserDto = z.infer<typeof userDtoSchema>;
```

Do not duplicate domain status literals or re-parse a value with the same schema after it has already crossed the boundary.

## Pattern: Model Named Partial State

Use this when a value has named fields and partial states, such as date ranges, filters, or paired inputs.

1. Use an object when each slot has a field name.
2. Use a discriminated union when empty, partial, and complete states behave differently.
3. Import a library-owned tuple type when an external component requires that exact API.

Example:

```ts
type DateRange =
  | { state: "empty" }
  | { state: "partial"; start: Date | null; end: Date | null }
  | { state: "complete"; start: Date; end: Date };
```

Do not define local tuple types with multiple nullable or optional slots, such as `[Date | null, Date | null]`.

## Pattern: Add A Server Boundary

Use this for routes, actions, jobs, and any server entrypoint that accepts outside input.

1. Keep raw input as `unknown` at the edge.
2. Establish identity and tenant scope with the required boundary functions.
3. Authorize before using request params or mutating state.
4. Validate with the contract schema.
5. Return a contract DTO or typed failure.

Current boundary functions are declared in `policy/registries/boundaries.yaml`.

Example shape:

```ts
export function updateUser(request: UpdateUserRequest): Promise<UserDto> {
  const principal = requireUser(request.context);
  const tenantId = requireTenant(request.context);
  authorize(principal, "project:update");
  const input = validateInput(updateUserInputSchema, request.body);

  return saveUserUpdate({ principal, tenantId, input });
}
```

Do not `JSON.parse` request data directly, skip authorization because the UI already checked it, or return `{}` / `[]` as a silent fallback.

Do not replace boundary validation with helper functions that repeatedly probe `unknown` or `any` values with `typeof`, `in`, and nested property checks just to recover a boolean. If a shape must be recognized, promote the check into a schema or a real type predicate owned by the boundary.

## Pattern: Add UI Data Loading

Use this when a component needs remote or async data.

1. Put transport logic in an API client/resource module, not inside the component.
2. Return a discriminated result union such as `loaded` / `failed`.
3. In the component, use a reducer/resource value rather than separate `data`, `loading`, and `error` state cells.
4. Consume contract types from `@agent-guardrails/contracts`.

Example:

```ts
export type LoadUserResult =
  | { state: "loaded"; user: UserDto }
  | { state: "failed"; message: string };
```

Do not put raw `fetch` calls in components or create parallel local user shapes for rendering.

## Pattern: Add An External SDK Or Service

Use this when adding Stripe, cloud SDKs, AI clients, or other external side effects.

1. Put direct SDK imports in `packages/gateways/src/<service>Gateway.ts`.
2. Centralize auth, timeout, retry, logging, and audit context in the gateway.
3. Export a small typed function or factory from the gateway package.
4. Add the banned direct import and wrapper path to `policy/registries/gateways.yaml`.

Do not import SDKs directly from apps, UI, domain, contracts, or API routes.

## Pattern: Add Generated Or Package Types

Use this when a code generator or installed package already provides a type.

1. Prefer importing the exported type.
2. If raw generated output needs a wrapper, declare that wrapper in `policy/registries/generated.yaml`.
3. Consumers import from the wrapper, not the raw generated path.
4. Do not hand-write a structural copy of generated or package-owned types.

## New Work Checklist

For larger changes, copy `docs/feature-slice-template.md` into the issue or PR notes before writing code.

Before implementing a new feature, answer these in the PR or issue:

- What concept is being added, and which module owns it?
- Is this a domain type, a contract DTO, an API boundary, a UI resource, or a gateway?
- Which existing type/schema/status/role can be imported instead of recreated?
- Which registry needs an ownership update?
- Which existing scoped rule or validation gate should fail if this pattern is violated?
