# no-wrapping-functions

Status: implemented as two stages; the typed stage is an error in the typed ESLint preset and the Oxlint preset does not run the syntax stage.

## Two-stage design (October 13, 2026)

Stage 1 is the portable syntax rule (`src/oxlint-plugin/portable/no-wrapping-functions.js`). It now also treats composed calls, template literals and object or array literals built from forwarded values as candidates, as the owner's ruling states. Stage 2 is the typed ESLint rule (`src/eslint-plugin/rules/no-wrapping-functions.js`). For each candidate it inlines the body at every reference in memory, deletes the function and its import specifiers, adds the imports the body needs, re-checks only the edited files with the TypeScript checker, and reports only verified hops. A candidate is kept as an owner when an overload, merged declaration, ambient declaration or default export needs the function, when any reference is not a direct call, when the package entry points export it, or when it binds a literal and is called from two or more modules. A type annotation alone is not a capability, and a hop without call sites is reported for deletion. Hazards reject the candidate: a parameter used other than exactly once in order, spread or extra call arguments, a call type that changes, a free name that resolves to another binding at a call site, any diagnostic the edit introduces, and any call site whose evaluation sequence the inline would change. The sequence check orders the body's steps as the program evaluates them; a property read counts as a read only when the checker resolves it to a non-accessor member of a non-nullable type, and calls, accessors, spreads and non-primitive template conversions count as effects. An argument may move past a preceding body step only when one of the two is immutable (a literal or a constant, function, class or enum binding) or both are reads. Receivers stay unbound through parentheses, `as`, `satisfies` and non-null wrappers. Each package entry maps to a source through the package's `build` script: the entry path itself, `tsc` outputs of the configs it names, or the inputs of the build tool it runs, read only from the tool's own entry keys in the configuration the file exports. When an exported candidate would otherwise verify but an entry maps to no source, the rule reports an incomplete-analysis diagnostic that names the entry and the cause. `typescript-engine.js` owns every program, checker and language-service call; `package-entry-points.js` reads package manifests and build declarations; `hop-inline-verification.js` holds the owner table and the edit plan. The raw TypeScript checker and language service are sufficient, so no ts-morph dependency is added.

The Oxlint preset turns the syntax stage off: Oxlint has no types and sees one file, so its report would restore the false positives the typed stage rejects.

## Fresh engine measurement on October 13, 2026

The scan covers commit `a73c1f2` over 59 repositories: 39 installed oss-corpus repositories and 20 agent-written applications. The population is every tracked TypeScript file; only the 2,217 files whose leading comment declares them generated are skipped, leaving 143,139 files. Files are grouped by the tsconfig that includes them, and 244 files outside every tsconfig get a default program. Stage 1 alone reports 13,043 candidates in 55 repositories; stages 1 and 2 report 5,216 verified hops in 51 repositories, 493 of them without call sites, plus 462 incomplete-analysis diagnostics in 26 repositories. A hit-weighted sample (seed 2026101323, at most 3 per repository, every earlier sampled location excluded) contains 30 hits from 21 repositories. Source review of complete declarations and checker-resolved references labels 27 true, for 90% precision, with 18 repositories at 70% or more. Labels froze before scoring (`labels.tsv`, SHA256 `aaa0c02bfed504424edf469b3b132c8f96feb8cd3d0b4ed1119785d83a03ea47`). All three false reports have no call site in their program: benchmark fixture exports loaded by name, a compile-time type test in a test body, and an export called from another TypeScript program. Verification takes a median of 32.1 ms per candidate (p90 313 ms, maximum 21.8 s); the largest repository peaks at 7.0 GB resident. Earlier rounds of 27/30 and 29/30 are superseded. Evidence remains in the shape-attempts hop-engine lane directory.

## Policy decision

On September 8, 2026 the owner explicitly chose a style policy against named delegation wrappers, asked for loud enforcement, and rejected a default-off rule. The owner decides the convention; the detector identifies the prohibited shape. A diagnostic does not claim that deleting a function is mechanically safe.

This is one general rule covering function declarations and named arrow/function expressions, including exports. It is not Convex-specific and does not require an explicit return annotation. Caller count matters only for the owner ruling on bound literals: a function that binds a literal and is called from two or more modules is kept. Anonymous inline callbacks do not add a named layer and are outside the rule.

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

The Oxlint plugin exports the syntax stage and the ESLint plugin exports the typed stage under the same rule name. Both presets register it off until a fresh measurement clears the bar.

## Validation

The packed consumer must report both a named declaration and a named arrow as errors through its ordinary default configuration, without any rule opt-in. It also exercises the portable plugin directly. Real-source inventory and the required `pnpm policy:verify-session` gate provide additional evidence. Final gate receipts and advisory findings are recorded with the completed change.

## Superseded measurement on October 13, 2026: no-wrapping-functions

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Repository evidence determines exclusions. Directory names alone do not. Missing or invalid compiler configurations exclude 618 files from both versions. No scanned file fails.

The old rule reports 3883 hits in 37 repositories. The new rule reports 3883 hits in 37 repositories. A round-robin sample with seed 2026101201 contains 20 hits. Source review labels 17 true, for 85% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: vitejs-vite, StefanTerdell-zod-to-json-schema, fabian-hiller-valibot, microsoft-playwright, edmundhung-conform, pingdotgg-t3code, openstatusHQ-openstatus, triggerdotdev-trigger.dev, arktypeio-arktype, calcom-cal.com, asteasolutions-zod-to-openapi, payloadcms-payload, twentyhq-twenty, trpc-trpc, TanStack-router, better-auth-better-auth, mastra-ai-mastra. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 0. There are no dropped hits. The false reports preserve a named receiving decoder or listener identity needed for cleanup. A short name alone does not justify a one-call function. The implementation is unchanged.

This superseded evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix/superseded-owner-fix-round`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-wrapping-functions.labels.tsv`. SHA256: `3c2690900414cdb5938d7ab4a297c4465990b4fb3309566107ff18ef3bfa1c95`. Frozen at 2026-10-13T05:07:01.009109+00:00.
- Label file: `dropped-no-wrapping-functions.labels.tsv`. SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Frozen at 2026-10-13T05:07:17.062133+00:00.

## Fresh measurement on October 13, 2026: no-wrapping-functions

The corpus contains 39 installed repositories from 44 fresh shallow clones. The old and new rules use the same eligible files and TypeScript programs. Both versions follow the shipped lint ignore list, including declaration files. Repository evidence establishes the other exclusions. Missing or invalid compiler configurations exclude 583 files from both versions. No scanned file fails.

The old rule reports 3823 hits in 37 repositories. The new rule reports 3823 hits in 37 repositories. A round-robin sample with seed 2026101302 contains 20 hits. Source review labels 14 true, for 70% precision. Labels freeze before scoring.

Sampled repositories at 70% or more: StefanTerdell-zod-to-json-schema, elysiajs-elysia, calcom-cal.com, vitest-dev-vitest, mastra-ai-mastra, formbricks-formbricks, fabian-hiller-valibot, anatine-zod-plugins, arktypeio-arktype, openstatusHQ-openstatus, ts-rest-ts-rest, trpc-trpc, inngest-inngest-js, excalidraw-excalidraw. Each percentage describes only the sampled hits, usually one per repository. It is not a repository-wide estimate.

The dropped-hit sample contains 0 true reports out of 0. There are no dropped hits. G10 treats a function whose body is one call as a hop unless it preserves a stated capability. The implementation is unchanged. The six false reports preserve a callback convention, deferred execution, callback identity, or a bound compiler interface.

Evidence remains at `/home/joedeleeuw/.local/state/lanes/antidrift-fix`. The measurement report lists every sampled location, repository result, and dropped-hit label.

- Label file: `new-no-wrapping-functions.labels.tsv`. SHA256: `d7de530f417ffcca03b65b8ae46e1555b6cf0f91f54f7b8bea8c77938e3714b1`. Frozen at 2026-10-13T07:14:23.636270+00:00.
- Label file: `dropped-no-wrapping-functions.labels.tsv`. SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Frozen at 2026-10-13T07:15:30.228917+00:00.
