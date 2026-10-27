# `antidrift/require-effect-deps`

## Definition

Require a dependency-array argument for React `useEffect` and `useLayoutEffect` calls imported from `react`.

This is narrower than `react-hooks/exhaustive-deps`. The official rule validates an array that exists; this rule catches the missing-array case where the effect runs after every render.

The remediation is to pass the dependencies the effect actually reads. `[]` is appropriate only for mount-only behavior. If running after every render is intentional, keep the behavior and use a rule-specific suppression with a reason; do not add `[]` merely to silence the diagnostic.

## Should Flag

```tsx
import { useEffect } from "react";

useEffect(() => {
  syncFromDom();
});
```

Why: omitting the second argument makes the effect run after every render, and `exhaustive-deps` does not report this shape.

```tsx
import * as React from "react";

React.useLayoutEffect(() => {
  measure();
});
```

Why: layout effects without a dependency array repeat every commit and need an explicit lifecycle contract.

## Should Not Flag

```tsx
useEffect(() => {
  sync(id);
}, [id]);
```

Why: the effect lifecycle is explicit, and `react-hooks/exhaustive-deps` owns dependency completeness.

```tsx
useEffect(() => {
  hydrateOnce();
}, []);
```

Why: mount-only behavior is explicit.

## Intentional Every-Render Escape

Do not infer intent from prose comments such as `// no deps` or `// runs every render`. That would make the rule depend on string matching and would let vague comments disable deterministic feedback.

If an effect genuinely must run every render, use the normal ESLint escape hatch with a rule-specific directive and a reason:

```tsx
// eslint-disable-next-line antidrift/require-effect-deps -- measure after every commit; reads refs only and does not set state
useLayoutEffect(() => {
  measureFromRefs();
});
```

The shared config already enforces disable descriptions through `@eslint-community/eslint-comments/require-description`, so the escape remains visible and reviewable.

## Ecosystem

- Oxlint's native React plugin owns `react/exhaustive-deps`, rules-of-hooks, and React Compiler diagnostics. The custom rule remains narrower: it requires the dependency-array argument that exhaustive-deps assumes already exists. A 2026-10-27 Oxlint 1.89 control covering direct aliased, namespace, and layout-effect calls without arrays produced zero native findings, so the native rule is not an equivalent replacement for this missing-array case.
- `eslint-plugin-use-effect-no-deps` overlaps with this rule's exact missing-array shape, but it is a small single-purpose package and is not a strong replacement for owning the rule in antidrift.
- `@eslint-react/eslint-plugin` / `eslint-plugin-react-hooks-extra` provide adjacent effect rules such as `no-direct-set-state-in-use-effect`, plus web API leak rules. Those are useful adjacent coverage, not a replacement for requiring a dependency-array argument.
- `eslint-plugin-react-you-might-not-need-an-effect` targets unnecessary effects. That is adjacent design feedback, not the missing-array contract.

## Historical real-corpus evidence

Missing-array cases:

- `/Users/sushi/code/chaski/src/frontend/portal/lib/hooks/useLatestCallbackRef.ts` line 26 omits the dependency array to keep the latest callback in a ref. Running after every render is intentional there; adding `[]` would be an incorrect repair. Use the documented reasoned suppression for this case.
- `/Users/sushi/code/claude-code-source-code/src/hooks/useAssistantHistory.ts` lines 199 and 218 omit dependency arrays.
- `/Users/sushi/code/claude-code-source-code/src/hooks/useVirtualScroll.ts` lines 591 and 619 omit dependency arrays.

Clean:

- `/Users/sushi/code/chaski/src/frontend/portal/lib/hooks/useDebounce.ts`
- `/Users/sushi/code/chaski/src/frontend/portal/modules/scenarios/hooks/use-sticky-column-offsets.ts`
- `/Users/sushi/code/sudocode-main/frontend/src/pages/IssueDetailPage.tsx`
- `/Users/sushi/code/codebase-atlas/src/components/AtlasGameStateShell.tsx`
- `/Users/sushi/code/murderbox/apps/client/src/lib/theme.ts`

## Current applicability

The rule is enabled because a missing dependency array is a distinct lifecycle case and Oxlint's native rule does not cover it. A report is not proof that every-render behavior is wrong; the diagnostic names the real-dependency repair and the reasoned suppression path rather than prescribing `[]`. Packed and real-repository controls provide behavioral evidence without a maturity label.
