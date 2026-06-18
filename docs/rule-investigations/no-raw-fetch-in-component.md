# `antidrift/no-raw-fetch-in-component`

## Definition

Disallow raw `fetch` calls inside a JSX-returning React component's lexical function frame.
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
export function OrdersPanel() {
  async function loadOrders() {
    return globalThis.fetch("/api/orders");
  }

  return <button onClick={loadOrders}>Load</button>;
}
```

Why: a helper declared inside the component is still owned by the component boundary, and spelling the browser fetch API through `globalThis`, `window`, or `self` is still raw transport.

## Should Not Flag

```ts
export async function loadOrders() {
  return fetch("/api/orders");
}
```

Why: transport is in a non-component API/client/resource module.

```tsx
async function downloadQrCode(url: string) {
  return fetch(url);
}

export function QrActionCard() {
  return <button onClick={() => void downloadQrCode("/qr.png")}>Download</button>;
}
```

Why: module-scope helpers are not proven to be component-owned by syntax alone. They need a separate transport-boundary rule or configured owner evidence before blocking.

```tsx
export function OrdersPanel() {
  const orders = useOrdersResource();
  return <section>{orders.state}</section>;
}
```

Why: the component consumes a resource value instead of owning transport.

## Ecosystem

`no-restricted-syntax` or `no-restricted-globals` can ban `fetch` in file globs, but that is a cruder replacement. Antidrift keeps the report tied to a JSX-returning React component lexical frame.

The broader problem space is not "fetch in X"; it is raw transport ownership. A future rule may become registry-backed and cover `fetch`, `axios`, generated clients, SDK calls, and project-specific transport functions across configured UI boundaries. That should be a separate scope decision, not silently folded into this rule.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/portal/components/ImpersonationWarning.tsx` line 85 exchanges an impersonation code with raw fetch inside a component effect.
- `/Users/sushi/code/codebase-atlas/src/routes/atlas.city.tsx` lines 50 and 76 fetch generated scene/audio JSON inside route component effects.

Clean:

- `/Users/sushi/code/chaski/src/frontend/monolithui/src/components/QrActionsAdmin/QrActionCard.tsx` keeps a module-scope QR download helper clean; component-module co-location is not enough proof.
- `/Users/sushi/code/chaski/src/frontend/monolithui/src/lib/crowdiesApi.ts` owns fetch in a client/helper module.
- `/Users/sushi/code/chaski/src/frontend/portal/components/EmbeddedDashboard.tsx` renders without raw transport.
- `/Users/sushi/code/sudocode-main/frontend/src/pages/ExecutionsPage.tsx` uses query/refetch state rather than raw component fetch.
- `/Users/sushi/code/murderbox/apps/client/app/api/[...path]+api.ts` owns proxy transport in an API module and stays clean.
- `/Users/sushi/code/murderbox/apps/client/app/(chat)/index.tsx` now uses `appFetch` / `appStreamFetch`, not raw `fetch`, and stays clean under this rule.

Pre-narrowing broad inventory on June 4, 2026:

- Chaski frontend: 1,577 checked files, 2 findings before module-scope helper fetches were removed from the blocking proof.
- Codebase Atlas `src`: 152 checked files, 2 findings.
- Sudocode frontend: 233 checked files, 0 findings.
- Murderbox client after `globalThis.fetch` hardening: 184 checked files, 7 findings before the June 17 narrowing.
- Taskme `src`: 8 checked files, 0 findings.

## Promotion State

Status: `ready`, `stable: false`.

Scope decision resolved on June 4, 2026: keep this as a narrow fetch-specific React boundary rule.
The broader raw transport ownership problem belongs in a separate registry-backed rule if real non-fetch drift justifies it.

The June 17, 2026 narrowing removed file-extension, PascalCase-name, and JSX-bearing-module heuristics. Re-promote only after re-inventorying the narrowed proof surface. Aliased or destructured fetch calls are not modeled until a real corpus program proves that shape matters.
