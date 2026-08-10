# no-explicit-type-arguments-on-owned-api

Reject caller-supplied type arguments where a registered API already owns inference.

## Intent

A registered API — a Convex generated function reference or a TanStack
`queryOptions`/`mutationOptions` registration — carries its result type in the
registration. When a call site supplies its own type argument, one of two
things is true: the argument restates the owner (redundant ceremony) or it
diverges from the owner (a silent fork that the compiler will not connect back
to the registration when the registration changes).

```ts
// drift: the reference type is restated; the registration already owns it
useQuery<typeof api.machines.list>(api.machines.list);

// drift: a handwritten result type forks machinesQuery's queryFn return
useQuery<HandwrittenMachine[]>(machinesQuery);
queryClient.getQueryData<HandwrittenMachine[]>(machinesQuery.queryKey);

// allowed: inference flows from the owner
useQuery(api.machines.list);
```

## Signal

TypeChecker symbol resolution, never name matching:

1. The callee resolves through the checker to a declaration inside the
   `convex` package's react surface (`useQuery`, `useMutation`, `useAction`,
   `usePaginatedQuery`) or the `@tanstack/react-query` / `@tanstack/query-core`
   packages (hooks and `QueryClient` read/write methods).
2. Owner existence proof:
   - Convex: the first argument is a member chain rooted at an import whose
     source ends with `convex/_generated/api`.
   - TanStack: the first argument resolves (identifier, or `.queryKey` member
     access) to a `queryOptions(...)` / `mutationOptions(...)` call result.
3. Any explicit type argument on such a call reports.

A locally declared function that merely shares the name `useQuery` is not
flagged, even when handed a generated api reference — the symbol must resolve
to the real package.

## Deliberate boundaries (false negatives by design)

- Ad-hoc TanStack key arrays (`getQueryData<T>(["machines"])`) stay silent: no
  registration exists to own the result.
- Inline options objects (`useQuery<T>({ queryKey, queryFn })`) stay silent:
  the call site is the definition site, not a registered owner.
- Wrapper hooks around `useQuery` are not followed; the registration chain
  would be speculative.

## Ecosystem check (2026-08-10)

`@typescript-eslint/no-unnecessary-type-arguments` fires only when an explicit
type argument equals the generic's default. It has no notion of registration
ownership and cannot flag a diverging caller-supplied type on an owned call.
No other maintained rule models generated-API or registration ownership.

## Corpus

- Murderbox (`apps/client`): clean-run control — zero explicit type arguments
  on Convex or TanStack owned calls across the app.
- Synthetic drift fixtures cover both owner sources and the name-collision
  guard.
