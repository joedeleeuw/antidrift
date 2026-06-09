# `antidrift/no-async-array-method`

## Definition

Disallow async callbacks in array methods that do not await callback promises, and require async `.map` / `.flatMap` callbacks to be joined by a Promise combinator.

This is a deterministic AST rule. The syntax is the bug: `.forEach`, `.filter`, `.some`, `.every`, `.find`, `.findIndex`, `.findLast`, `.findLastIndex`, and `.sort` never await an async callback. `.map` and `.flatMap` may be correct only when the returned promise list is awaited through `Promise.all`, `Promise.allSettled`, or `Promise.race`.

## Should Flag

```ts
ids.forEach(async (id) => {
  await cleanupProject(id);
});
```

Why: `forEach` drops the returned promises, so cleanup starts in the background and the caller can finish before cleanup has completed.

```ts
const rows = items.map(async (item) => save(item));
return rows.length;
```

Why: the array contains promises, but nothing joins or awaits them.

## Should Not Flag

```ts
for (const id of ids) {
  await cleanupProject(id);
}
```

Why: the loop awaits each async operation explicitly.

```ts
await Promise.all(items.map(async (item) => save(item)));
```

Why: `.map(async ...)` is joined by a Promise combinator.

```ts
const saves = items.map(async (item) => save(item));
await Promise.all(saves);
```

Why: the rule tracks the local promise list and sees it awaited later.

## Ecosystem

`@typescript-eslint/no-misused-promises` and `@typescript-eslint/no-floating-promises` partially overlap. `no-misused-promises` can cover async predicate callbacks and can catch `forEach(async ...)` when broad `checksVoidReturn.arguments` is enabled, but that broader option also reports legitimate Express-style async handlers in common projects. The remaining custom value is the array-method-only scope plus `.map` / `.flatMap` promise-list joining: unjoined async maps are not covered by the local ecosystem pair.

Closest online references checked:

- `@typescript-eslint/no-misused-promises` documents `checksVoidReturn.arguments` and shows `forEach(async ...)` as an incorrect void-callback example, with `Promise.all([].map(async ...))` as the accepted shape.
- `@typescript-eslint/strict-void-return` documents the broader "returned value in void context" family and points async-only misuse back to `no-misused-promises`.
- `eslint-plugin-no-async-array-methods` exists and directly bans async callbacks for array methods, but it is a small standalone plugin with weaker maintenance/support than the TypeScript ESLint stack.
- ESLint core `no-await-in-loop` is adjacent but points the other direction: it encourages starting promises and joining them with `Promise.all`, not banning async array callbacks.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/sudocode-main/server/tests/integration/multi-project.test.ts` line 142 uses `openedProjectIds.forEach(async ...)`, starting cleanup requests without awaiting them.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/gateways/google-maps-gateway.ts` assigns `.map(async ...)` to `detailsPromises` and awaits `Promise.all(detailsPromises)`.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/scenarios-router.ts` wraps `.map(async ...)` directly in `Promise.all`.
- `/Users/sushi/code/chaski/src/frontend/bff/api/routers/product-set-router.ts` uses `Promise.allSettled`.
- `/Users/sushi/code/codebase-atlas/src/services/debugBundleService.ts` wraps `files.map(async ...)` directly in `Promise.all`.
- `/Users/sushi/code/sudocode-main/server/src/routes/projects.ts` wraps async directory reads in `Promise.all`.

Broad inventory on 2026-06-04:

- Chaski `src`: 1,580 checked files, 0 findings.
- Codebase Atlas `src`: 152 checked files, 0 findings.
- Sudocode app and test source: 561 checked files, 1 finding.

## Promotion State

Status: `ready`, `stable: false`.

The rule is clean across the broad inventory and has clear deterministic syntax, but stable promotion still needs either a second independent drift instance or an explicit exception to the usual multi-repository drift-replication gate.
