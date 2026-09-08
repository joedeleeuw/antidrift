# no-wrapping-functions

Status: implemented; default error in the shared governance preset. Stable semantic-redundancy detection is not claimed.

## Policy decision

On September 8, 2026 the owner explicitly chose a style policy against named delegation wrappers, asked for loud enforcement, and rejected a default-off rule. The owner decides the convention; the detector identifies the prohibited shape. A diagnostic does not claim that deleting a function is mechanically safe.

This is one general rule covering function declarations and named arrow/function expressions, including exports. It is not Convex-specific, does not depend on the number of callers, and does not require an explicit return annotation. Anonymous inline callbacks do not add a named layer and are outside the rule.

The initial advisory argued against broad enforcement because a wrapper can name a domain concept or a future extension point. The owner explicitly rejected those as sufficient justifications for the extra function. That supersedes the initial default-off proposal. The advisory's concrete concerns about callback timing, receivers and public APIs remain relevant to remediation. The retired `no-thin-typed-factory-wrapper` stays retired: its typed-return claim is a different rule.

## What reports

A named synchronous, non-generator function whose body is one returned call, one call statement, or an arrow call expression. The callee is an identifier or ordinary noncomputed member path. Arguments are references, literals, empty objects/arrays, or identifier spreads. Parameter defaults/destructuring, generic specialization, type predicates, optional calls, receiver expressions such as `this`, argument computations, nested calls and result processing are outside this initial scope.

```ts
export function useMachines() {
  return useConvexQuery(convexApi.machines.list, {});
}

export const loadItem = (id) => owner.load(id);

function closeItem(id) {
  owner.close(id);
}
```

All three report. A name, an export, or changing a declaration into a named arrow does not exempt the wrapper. A named callback can report too; the rule does not infer that its binding is required by a callback contract, so its signature and identity requirements must be considered when fixing it.

These stay clean:

```ts
button.onClick(() => owner.close(id));
const area = (radius) => Math.PI * radius ** 2;
const caption = (item) => renderLabel(item.name.toUpperCase());
function readRequired(id) {
  const item = owner.load(id);
  if (!item) throw new Error("Missing item");
  return item;
}
```

Class and object methods are outside this initial function-declaration/variable scope. The rule has no autofix. Inline the existing call at its callers while preserving argument order, timing, receiver and hook position. When an API requires a callback, preserve both its signature and stable identity: direct callback substitution is valid only when the existing owner already has the exact compatible signature and receiver behavior. For example, replace `const subscribe = (onStoreChange) => subscribeToConsent(onStoreChange)` with `useSyncExternalStore(subscribeToConsent, getSnapshot)` only when `subscribeToConsent` is the compatible owner; this keeps a module-level callback identity instead of creating a new adapter on every render. Do not replace a required stable adapter with an inline arrow, `.bind`, or a fake statement just to silence the diagnostic. If argument adaptation, receiver binding, hook position, or a named callback identity is required, retain the boundary through the repository's existing documented exception process; the shared rule stays enabled.

## Real source evidence

The first inventory ran the actual portable rule with the TypeScript ESLint parser against tracked, non-test, non-generated source. It inspected 692 Homer files, 1,207 ChatBiz files and 204 Antidrift files. Receipt files include repository revisions, source hashes and exact diagnostics under `/Users/sushi/code/homer-recovery/2026-09-08/wrapping-rule-corpus-*.json`. The initial ChatBiz inventory also surfaced two unrelated inline-disable references to plugins not loaded by the isolated harness; those are not wrapper diagnostics or parser failures.

- Homer at `b5636395`: `apps/client/src/lib/data.ts:124`, `useMachines`, is the motivating exported nullary wrapper. Seven callers can name the generated query directly. The existing lint configuration did not catch it. The isolated Homer change removes it and retains generated types.
- Homer: the other five custom Convex query hooks combine queries, derive state, own writes or handle a platform contract. They are clean controls. `useClerkAuthForConvex` is currently clean only because its non-empty options object is outside this initial argument-shape subset; the detector does not understand that it is passed as the required `useAuth` callback to `ConvexProviderWithClerk`. A zero-argument or empty-object version of the same provider hook would report and would need the callback boundary exception, not an inline hook call.
- ChatBiz: `src/app/(guest)/onboarding/scheduling/use-scheduling.ts:67`, `useSchedulingOptional`, delegates to `useContext(SchedulingContext)`; the adjacent `useScheduling` owns a missing-provider check and stays clean.
- ChatBiz: `src/components/analytics/brevo-tracker.tsx:17`, `subscribe`, delegates directly to `subscribeToConsent`. The default policy reports this named layer; replacing it is safe only by passing `subscribeToConsent` directly when its callback signature and receiver behavior match `useSyncExternalStore`. That direct substitution preserves the stable module-level identity; a newly created inline adapter would change subscription timing and identity.
- Antidrift's real default gate found 25 named wrappers. The change removes the extra layers and drives the existing callees directly. Internal implementations are consolidated where an existing public function already owns the operation.

These are style-policy matches, not a claim that all reported functions are semantic bugs. No second repository was modified merely to create a positive example. Codebase Atlas was not used as a fresh corpus: the available directory was not a Git checkout. Its historical derived-constructor controls remain recorded in the retired investigation.

## Ecosystem and runtime ownership

ESLint's [no-useless-call](https://eslint.org/docs/latest/rules/no-useless-call) checks redundant `.call()` and `.apply()`. Unicorn's [prefer-native-coercion-functions](https://github.com/sindresorhus/eslint-plugin-unicorn/blob/main/docs/rules/prefer-native-coercion-functions.md) targets native coercion functions. The existing Antidrift `no-trivial-property-helpers` targets named property access and fallback helpers. None catches general named delegation.

One implementation is exported from both plugin entrypoints. The shared governance preset enables it at error severity through Oxlint. The reduced typed ESLint pass does not run it a second time. Consumers using ESLint alone can enable `antidrift/no-wrapping-functions` with the same implementation.

## Validation

The packed consumer must report both a named declaration and a named arrow as errors through its ordinary default configuration, without any rule opt-in. It also exercises the portable plugin directly. Real-source inventory and the required `pnpm policy:verify-session` gate provide additional evidence. Final gate receipts and advisory findings are recorded with the completed change.
