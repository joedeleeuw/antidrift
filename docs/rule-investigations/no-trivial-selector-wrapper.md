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

Single-property adapter callbacks are valid functions, but they do not need explicit return annotations when the body already infers the adapter contract:

```ts
function chatItemKey(item: ChatItem): string {
  return item.id;
}

<List keyExtractor={chatItemKey} />;
```

This callback can stay named and stable for the external API. The drift is the explicit `: string`, not the callback itself:

```ts
function chatItemKey(item: ChatItem) {
  return item.id;
}
```

Do not add a use-site-aware exemption. Detecting adapter intent would require prop-name matching such as `select`, `keyExtractor`, `getRowId`, or `itemKey`, and the same remediation still applies: keep the callback, let the return type infer.

Use a local directive only when an external API genuinely requires a separately declared annotated callback type:

```ts
// eslint-disable-next-line antidrift/no-trivial-selector-wrapper -- external adapter type requires annotated callback signature
function chatItemKey(item: ChatItem): string {
  return item.id;
}
```

The shared config requires descriptions on ESLint directives, so the exception remains auditable.

## Real-Corpus Evidence

Drift:

- `/Users/sushi/code/chaski/src/frontend/portal/modules/scenarios/agent-configuration/components/table/use-agent-table-data.ts` line 15.
- `/Users/sushi/code/chaski/src/frontend/portal/modules/scenarios/service-time-influence/components/table/service-time-influence-table.tsx` line 39.
- `/Users/sushi/code/codebase-atlas/src/parsing/treeSitterRealProgramParser.ts` line 916 defines `fullExcerpt(file: ParsedFile): string { return file.source }`, proving the non-name-gated case.
- `/Users/sushi/code/murderbox/apps/client/src/components/chat/message-list.tsx` line 189 defines `chatItemKey(item: ChatItem): string { return item.id; }`, proving adapter callbacks can keep their stable helper while dropping the return annotation.

Clean:

- `/Users/sushi/code/chaski/src/frontend/bff/api/services/helpers.ts`
- `/Users/sushi/code/chaski/src/frontend/portal/modules/Accounts/formatters.ts`
- Adjacent Codebase Atlas helpers such as `compactText` transform the returned text and stay outside the bare-member shape.

Follow-up adapter scan:

- A local scan of Chaski, Codebase Atlas, Murderbox, Sudocode, and Cloudflare Agents found adapter callback pressure in Chaski TanStack Query/table selectors and Murderbox list key extraction.
- The same scan found adjacent inline key extractors such as `keyExtractor={(item) => item.kind}`, but those have no explicit return type and are outside this rule's inference-appeasement scope.
- Adapter pressure is resolved by dropping the explicit return annotation, not by adding `select` / `keyExtractor` / `getRowId` prop-name exemptions.
- Cloudflare test helper findings such as `callText(result): string { return ...text }` are real rule hits but test-only and do not count toward stable non-test drift replication.

## Promotion State

Status: `ready`, `stable: true`.

The rule is stable for the current scope. Drift replicates across Chaski, Codebase Atlas, and Murderbox; clean controls cover transformed helpers and unannotated selectors. Keep the rule structural and do not add adapter prop-name heuristics unless future evidence shows an annotated callback type is genuinely required.
