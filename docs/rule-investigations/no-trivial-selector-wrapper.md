# `antidrift/no-trivial-selector-wrapper`

## Definition

Disallow typed internal helpers that only return a member access rooted in one of their own parameters.

The rule is structural: it does not depend on names such as `getXFromY`.

## Should Flag

```ts
function pickItems(bag: Bag): Item[] {
  return bag.items;
}
```

Why: the explicit return type is restating the property contract. Use `bag.items` directly or move the contract to the owning boundary.

```ts
const fullExcerpt = (file: ParsedFile): string => file.source;
```

Why: this is the same wrapper shape even though the name is not `getXFromY`.

## Should Not Flag

```ts
function compactText(file: ParsedFile, node: TreeSitterNode): string {
  return text(file, node).replace(/\s+/g, " ").trim();
}
```

Why: the helper transforms data instead of returning a bare member.

```ts
function pickItems(bag: Bag) {
  return bag.items;
}
```

Why: without an explicit return type, inference is already doing the work.

```ts
export function pickItems(bag: Bag): Item[] {
  return bag.items;
}
```

Why: exported functions are public boundaries. Their explicit return type may be part of the package contract.

## Adapter Callback Classification

Single-property adapter callbacks are the real production risk:

```ts
function chatItemKey(item: ChatItem): string {
  return item.id;
}

<List keyExtractor={chatItemKey} />;
```

This can be legitimate because the callback adapts a domain object to an external API that demands a string key. The current rule still reports the helper when it is internal and typed.

Do not add a broad structural exemption yet. The code shape is identical to the drift shape, and detecting adapter intent would require use-site analysis or prop-name matching such as `keyExtractor`, `getRowId`, or `itemKey`. That would move the rule back toward contextual/name heuristics.

For now, intentional adapters should use a local, reasoned directive:

```ts
// eslint-disable-next-line antidrift/no-trivial-selector-wrapper -- adapter callback for List keyExtractor API
function chatItemKey(item: ChatItem): string {
  return item.id;
}
```

The shared config requires descriptions on ESLint directives, so the exception remains auditable.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/portal/modules/scenarios/agent-configuration/components/table/use-agent-table-data.ts` line 15.
- `/Users/sushi/code/chaski/src/frontend/portal/modules/scenarios/service-time-influence/components/table/service-time-influence-table.tsx` line 39.
- `/Users/sushi/code/codebase-atlas/src/parsing/treeSitterRealProgramParser.ts` line 897 defines `fullExcerpt(file: ParsedFile): string { return file.source }`, proving the non-name-gated case.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/services/helpers.ts`
- `/Users/sushi/code/chaski/src/frontend/portal/modules/Accounts/formatters.ts`
- Adjacent Codebase Atlas helpers such as `compactText` transform the returned text and stay outside the bare-member shape.

Review-risk evidence:

- `/Users/sushi/code/murderbox/apps/client/src/components/chat/message-list.tsx` has `chatItemKey(item: ChatItem): string { return item.id; }`, used as a key extractor. This is not accepted as stable drift or clean evidence yet; it is the false-positive shape to classify before promotion.

## Promotion State

Status: `ready`, `stable: false`.

Stable promotion is blocked on adapter callback classification. Until there is repeated real pressure for a use-site-aware exemption, keep the rule structural and require local reasoned disables for intentional adapters.
