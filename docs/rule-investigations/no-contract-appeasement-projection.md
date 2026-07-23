# `antidrift/no-contract-appeasement-projection`

## Definition

Disallow internal helpers that use an explicit return type to project one source value contract into another return contract without constructing, parsing, validating, or crossing an exported adapter boundary.

This subsumes the old selector-wrapper branch:

```ts
function pickItems(bag: Bag): Item[] {
  return bag.items;
}
```

It also covers cross-contract discriminant projection:

```ts
function actionForEventKind(
  eventKind: EventKind,
): MemoryResult["action"] | undefined {
  if (eventKind === "recall" || eventKind === "capture") return eventKind;
  return undefined;
}
```

Why: `EventKind` and `MemoryResult["action"]` are separate contracts. The helper exists to make one owned type fit another local return shape instead of removing the unneeded field, using the source value directly, or constructing the target contract at its owner.

## Proof

The rule requires TypeScript parser services.

It reports only when:

- the callable is internal, not an exported/public boundary
- the callable has an explicit return type
- the body contains no call or `new` expression
- every meaningful return path is a parameter, parameter member, destructured parameter binding, guarded matching literal, or `undefined` fallback
- TypeChecker proof shows either a cross-owner projection or an exact projected-type restatement

The selector-wrapper branch remains covered by exact projected-type restatement. The discriminant branch is covered by source-owner and return-owner mismatch.

## Should Not Flag

```ts
export function actionForEventKind(
  eventKind: EventKind,
): MemoryResult["action"] | undefined {
  if (eventKind === "recall" || eventKind === "capture") return eventKind;
  return undefined;
}
```

Why: exported functions are public boundaries. Their explicit return type may be part of the package contract.

```ts
function parseAction(raw: unknown): MemoryResult["action"] {
  return ActionSchema.parse(raw);
}
```

Why: schema parsing constructs the target contract at a validation boundary.

```ts
function routeEventKind(eventKind: EventKind): string {
  if (eventKind === "tool") return "run-tool";
  return eventKind === "recall" ? "load-memory" : "save-memory";
}
```

Why: this is behavior routing with different output literals, not projection of one contract into another.

## Real-Corpus Evidence

Inherited selector-wrapper drift:

- Chaski `src/frontend/portal/modules/scenarios/agent-configuration/components/table/use-agent-table-data.ts` line 15.
- Chaski `src/frontend/portal/modules/scenarios/service-time-influence/components/table/service-time-influence-table.tsx` line 39.
- Codebase Atlas `src/parsing/treeSitterRealProgramParser.ts` line 916 defines `fullExcerpt(file: ParsedFile): string { return file.source }`.

Murderbox's former `chatItemKey(item: ChatItem): string` drift was remediated in commit `d02b615e` by inlining the key extractor. A current scan of its 341 client TypeScript files reports no findings, so that stale corpus case was deleted rather than relabeled.

Inherited selector-wrapper clean controls:

- Chaski `src/frontend/bff/api/services/helpers.ts`.
- Chaski `src/frontend/portal/modules/Accounts/formatters.ts`.
- Adjacent Codebase Atlas helpers such as `compactText` transform the returned text and stay outside the bare-member shape.
- Inline adapter callbacks such as `keyExtractor={(item) => item.kind}` have no explicit return type and remain outside this rule's contract-appeasement scope.

Single-property adapter callbacks can stay named for an external API, but they do not need explicit return annotations when the body already infers the adapter contract:

```ts
function chatItemKey(item: ChatItem) {
  return item.id;
}
```

Use a local directive only when an external API genuinely requires a separately declared annotated callback type:

```ts
// eslint-disable-next-line antidrift/no-contract-appeasement-projection -- external adapter type requires annotated callback signature
function chatItemKey(item: ChatItem): string {
  return item.id;
}
```

The shared config requires descriptions on ESLint directives, so the exception remains auditable.

The widened cross-contract projection branch currently has regression fixtures for `EventKind -> MemoryResult["action"] | undefined`; it still needs real source findings before stable promotion.

## Known False Negatives

- Local variable indirection is not modeled yet: `const items = bag.items; return items;` stays clean.
- Any call or `new` expression in the helper body is treated as construction or validation pressure. This keeps parser/validator-backed conversion clean, but it also leaves side-effect variants such as `log(bag.items); return bag.items;` clean.

## Promotion State

Status: `ready`, `stable: false`.

The inherited selector-wrapper branch had stable evidence. The broadened rule is ready as a blocking guardrail because it keeps the same strict internal-helper proof floor and adds TypeChecker ownership proof, but the new cross-contract branch and the known false-negative gaps must be mined against real repos before this row can return to stable.
