# `antidrift/no-raw-fetch-in-component`

## Definition

Disallow raw `fetch` calls inside React components or component modules.
The modeled global forms are `fetch(...)`, `globalThis.fetch(...)`, `window.fetch(...)`, and `self.fetch(...)`.

This is the current enforcement slice for the broader transport-boundary problem: UI should consume API clients, loaders, resource hooks, or query resources instead of owning HTTP transport directly.

## Should Flag

```tsx
function OrdersPanel() {
  React.useEffect(() => {
    void fetch("/api/orders");
  }, []);

  return <section />;
}
```

Why: the component now owns transport, parsing, loading/error behavior, and contract assumptions.

```tsx
async function loadOrders() {
  return fetch("/api/orders");
}

export function OrdersPanel() {
  return <button onClick={loadOrders}>Load</button>;
}
```

Why: a helper colocated in a component module still leaves transport owned by the UI boundary.

```tsx
async function loadImage(url: string) {
  return globalThis.fetch(url);
}

export function ImagePanel() {
  return <button onClick={() => void loadImage("/asset.png")} />;
}
```

Why: spelling the browser fetch API through `globalThis`, `window`, or `self` is still raw component-module transport.

## Should Not Flag

```ts
export async function loadOrders() {
  return fetch("/api/orders");
}
```

Why: transport is in a non-component API/client/resource module.

```tsx
export function OrdersPanel() {
  const orders = useOrdersResource();
  return <section>{orders.state}</section>;
}
```

Why: the component consumes a resource value instead of owning transport.

## Ecosystem

`no-restricted-syntax` or `no-restricted-globals` can ban `fetch` in file globs, but that is a cruder replacement. Antidrift keeps the report tied to React component context and component modules.

The broader problem space is not "fetch in X"; it is raw transport ownership. A future rule may become registry-backed and cover `fetch`, `axios`, generated clients, SDK calls, and project-specific transport functions across configured UI boundaries. That should be a separate scope decision, not silently folded into this rule.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/monolithui/src/components/QrActionsAdmin/QrActionCard.tsx` line 41 fetches a QR image inside a component module helper.
- `/Users/sushi/code/chaski/src/frontend/portal/components/ImpersonationWarning.tsx` line 85 exchanges an impersonation code with raw fetch inside a component effect.
- `/Users/sushi/code/codebase-atlas/src/routes/atlas.city.tsx` lines 50 and 76 fetch generated scene/audio JSON inside route component effects.
- `/Users/sushi/code/murderbox/apps/client/app/(chat)/index.tsx` line 459 calls `globalThis.fetch` inside a component module helper, and line 704 calls bare `fetch` from the same module.
- Broad inventory also found Murderbox component-module fetches in `apps/client/app/(models)/admin.tsx`, `apps/client/app/_debug.tsx`, and `apps/client/src/components/chat/message-list.tsx`.

Clean:

- `/Users/sushi/code/chaski/src/frontend/monolithui/src/lib/crowdiesApi.ts` owns fetch in a client/helper module.
- `/Users/sushi/code/chaski/src/frontend/portal/components/EmbeddedDashboard.tsx` renders without raw transport.
- `/Users/sushi/code/sudocode-main/frontend/src/pages/ExecutionsPage.tsx` uses query/refetch state rather than raw component fetch.
- `/Users/sushi/code/murderbox/apps/client/app/api/[...path]+api.ts` owns proxy transport in an API module and stays clean.

Broad inventory on June 4, 2026:

- Chaski frontend: 1,577 checked files, 2 findings.
- Codebase Atlas `src`: 152 checked files, 2 findings.
- Sudocode frontend: 233 checked files, 0 findings.
- Murderbox client after `globalThis.fetch` hardening: 184 checked files, 7 findings.
- Taskme `src`: 8 checked files, 0 findings.

## Promotion State

Status: `ready`, `stable: false`.

Scope decision resolved on June 4, 2026: keep this as a narrow fetch-specific React boundary rule.
The broader raw transport ownership problem belongs in a separate registry-backed rule if real non-fetch drift justifies it.

Stable promotion is no longer blocked on scope, but it still needs the final grounded advisory/promotion review. Aliased or destructured fetch calls are not modeled until a real corpus program proves that shape matters.
