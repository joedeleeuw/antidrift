const mergedShapeBadSource = `
type InlineNodePair =
  | { id: string; parentId: string; text: string }
  | { id: string; parentId: string; src: string };

interface BaseRoot { rootId: string; }
interface FirstExtended extends BaseRoot { role: string; scope: string; }
interface DuplicateExtended extends BaseRoot { role: string; scope: string; }

declare function useEntityQuery<T>(key: string): { data: T; isPending: boolean; error: Error | null };
declare function useAtomValue<T>(atom: string): T;
declare function useSelector<T>(selector: string): T;
declare function useStore<T>(store: string): T;
declare function createMemo<T>(read: () => T): () => T;

export function useReconciledEntity() {
  const summary = useEntityQuery<{ title: string; author: string }>("summary");
  const detail = useEntityQuery<{ title: string; author: string }>("detail");
  return { title: summary.data.title ?? detail.data.title, author: summary.data.author ?? detail.data.author };
}

export function useKeyedEntities() {
  const entries = useAtomValue<{ id: string; label: string }[]>("entries");
  const lookup = useSelector<Map<string, string>>("labels");
  const joined = entries.map((entry) => ({ ...entry, label: lookup.get(entry.id) }));
  const filtered = joined.filter((entry) => entry.label);
  const extras = useStore<Record<string, number>>("extras");
  const enriched = filtered.map((entry) => ({ ...entry, count: extras[entry.id] }));
  return enriched;
}

export function useLoopEntities() {
  const entries = useAtomValue<{ id: string; title: string }[]>("entries");
  const lookup = useStore<Record<string, string>>("labels");
  const projected = [];
  for (const entry of entries) {
    const label = lookup[entry.id];
    projected.push({ ...entry, label });
  }
  return projected;
}

export function useMemoEntities() {
  const entries = createMemo(() => useAtomValue<{ id: string }[]>("entries"));
  const labels = createMemo(() => useStore<Map<string, string>>("labels"));
  return entries().map((entry) => ({ ...entry, label: labels().get(entry.id) }));
}

export function writeSessionAliases(sessionId: string) {
  return { parentSessionId: sessionId, parentSessionID: sessionId };
}
export function assignSessionAliases(target: Record<string, string>, sessionId: string) {
  target.parentSessionId = sessionId;
  target.parent_session_id = sessionId;
  return target;
}

interface ThreadCard { id: string; title: string; comments: string[]; completed: boolean; retryCount: number; }
export function padThreadCard(thread: { id: string; title: string }) {
  const comments = [];
  return { id: thread.id, title: thread.title, comments, completed: false, retryCount: 0 } as ThreadCard;
}
`;

export const mergedShapeGoodSource = `
interface NodeBase { id: string; parentId: string; }
interface TextNode extends NodeBase { text: string; }
interface ImageNode extends NodeBase { src: string; }
export function readNode(node: TextNode | ImageNode) {
  return "text" in node ? node.text : node.src;
}

type DisjointSharedFields =
  | { id: string; text: string }
  | { id: string; parentId: string; count: number }
  | { parentId: string; src: string };
export function readDisjoint(entry: DisjointSharedFields) {
  return Object.keys(entry);
}

interface Options { timeout: number; retries: number; }
export function configureOptions(supplied: Partial<Options>, defaults: Options) {
  const options = { timeout: supplied.timeout ?? defaults.timeout, retries: supplied.retries ?? defaults.retries };
  return options;
}
interface CreateTask { id: string; title: string; }
interface Task { id: string; title: string; comments: string[]; completed: boolean; retryCount: number; }
export function createTask(command: CreateTask): Task {
  return {
    id: command.id,
    title: command.title,
    comments: [],
    completed: false,
    retryCount: 0,
  };
}

declare function useCollectionQuery<T>(key: string): { data: T; isPending: boolean; error: Error | null };
declare function useAtomValue<T>(atom: string): T;
declare function useMemo<T>(build: () => T, dependencies: unknown[]): T;
export function useSeparateQueryProperties() {
  const first = useCollectionQuery<string[]>("entries");
  const second = useCollectionQuery<string[]>("status");
  const bag = { entries: first.data, loading: second.isPending, failure: second.error };
  const { entries } = bag;
  const selected = useMemo(() => entries.map((entry) => entry.trim()), [first, second]);
  return { selected, loading: bag.loading };
}
export function useDistinctBagProperties() {
  const first = useCollectionQuery<string[]>("first");
  const second = useCollectionQuery<number[]>("second");
  const bag = { entries: first.data, counts: second.data };
  const alias = bag;
  const { entries } = alias;
  return entries.map((entry) => entry.trim());
}
export function useImperativeLookup() {
  const entries = useAtomValue<{ id: string }[]>("entries");
  const domMap = useAtomValue<Map<string, { focus(): void }>>("elements");
  return entries.map((entry) => {
    domMap.get(entry.id)?.focus();
    return entry.id;
  });
}
export function separateAliasWrites(target: Record<string, string>, nextId: () => string) {
  target.parentSessionId = nextId();
  target.parentSessionID = nextId();
  return { userId: nextId(), userID: nextId() };
}
export function distinctAliasBindings(firstId: string, secondId: string) {
  return { userId: firstId, userID: secondId };
}
`;

export const badSource = `
${mergedShapeBadSource}
import { useState, useSyncExternalStore } from "react";
import { TouchableOpacity } from "react-native";
import { Text as WidgetText } from "@expo/ui/swift-ui";
import { z } from "zod";

declare const process: { env: { NODE_ENV: string } };
declare function makeMutable(initial: number): { current: number };
export const sharedProgress = makeMutable(0);

type HiddenUnknown = unknown;
export const ORDER_MODES = ["fast", "slow"] as const;
export type OrderMode = "fast" | "slow";

interface FirstContract { id: string; title: string; count: number; }
interface DuplicateContract { id: string; title: string; count: number; }
interface UntaggedFailureBag { target: string | null; unavailableReason: string | null; }
export interface WorkspaceSidecarSlice {
  tabsByWorkspace: Record<string, string[]>;
  activeTabByWorkspace: Record<string, string>;
  expandedDirsByWorkspace: Record<string, string[]>;
}
export function readDualKeyAlias(input: { taskId?: string; task_id?: string }) {
  return input.taskId ?? input.task_id;
}
const BaseItemSchema = z.object({ oldField: z.string(), payloadJson: z.string().catch("default") });
export const UnvalidatedHoleSchema = z.object({
  anything: z.any(),
  uncheckedCustom: z.custom<FirstContract>(),
  noopUnknownTransform: z.unknown().transform((rawPayload) => String(rawPayload)),
  widenedUnion: z.union([z.string(), z.unknown()]),
});
const LsofExitSchema = z.object({ code: z.literal(1) });
export function catchWithSchemaDecode(
  run: () => number[],
  rawStdout: string
): number[] {
  const [hours, minutes] = "08:30".split(":").map(Number);
  const finiteRows = rawStdout
    .split(/\\r?\\n/)
    .map((line) => Number(line))
    .filter((seconds) => Number.isFinite(seconds));
  if (hours < 0 || minutes < 0 || finiteRows.length < 0) return [];
  try {
    return rawStdout
      .split("\\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => Number(line));
  } catch (caughtErr) {
    if (LsofExitSchema.safeParse(caughtErr).success) return [];
    if (caughtErr.message.includes("ENOENT")) return [0];
    throw new Error("lsof failed", { cause: caughtErr });
  }
}
type NamedItem = z.infer<typeof BaseItemSchema>;
export function reparseNamedAlias(entry: NamedItem) {
  return BaseItemSchema.parse(entry);
}
export const RenamedItemSchema = BaseItemSchema.omit({ oldField: true }).extend({ newField: z.string() });
const outerGreeting = "Hello";
export function BrokenWidget() { "widget"; return <WidgetText>{outerGreeting}</WidgetText>; }
function getUnstableSnapshot() { return { now: 1 }; }

export function LegacyTouchableView({ subscribe }: { subscribe: () => () => void }) {
  const snap = useSyncExternalStore(subscribe, getUnstableSnapshot);
  return <TouchableOpacity>{snap.now}</TouchableOpacity>;
}

export function processLegacyData(
  items: number[],
  mode: string,
  rawJson: string,
  payload: unknown
) {
  let chosen: number;
  if (mode === "fast") {
    chosen = 1;
    return JSON.parse(rawJson) as FirstContract;
  } else if (mode === "slow") {
    chosen = 2;
    return (payload as unknown as FirstContract).title;
  } else if (mode === "medium") {
    chosen = 3;
  } else if (mode === "turbo") {
    chosen = 4;
  } else {
    chosen = 5;
  }
  const erasedKnown = { id: "known" } as unknown;
  const parsed = z.object({ id: z.string() }).parse(erasedKnown);
  return [chosen, z.object({ id: z.string() }).parse(parsed)];
}

export async function runInParallel(urls: string[], children: { parentId: string; id: string }[]) {
  for (const url of urls) {
    children.find((child) => child.parentId === url.trim);
  }
  urls.forEach(async (url) => {
    await fetch(url);
  });
}

let globalUiOpen = false;

export function BadComponent({ items = [] }: { items?: string[] }) {
  globalUiOpen = items?.length !== 0;
  const randomId = Math.random();
  return <div>{randomId}{items.length}</div>;
}

function combineLabels(first: string, second: string, third: string, fourth: string) {
  return [first, second, third, fourth].join(" ");
}

export function forwardLabels(first: string, second: string, third: string, fourth: string) {
  return combineLabels(first, second, third, fourth);
}

export function missingLabel(entry: { label?: string }) {
  return entry.label ?? "unknown";
}

export function shredUnionAndRepeatNullable(
  scope: { kind: "machine"; machineId: string } | { kind: "project"; projectId: string },
  entry: { a: string; b: number; c: boolean } | null,
  bag: { setA: () => void; setB: () => void; getC: () => string },
  wide: {
    p1: number; p2: number; p3: number; p4: number; p5: number; p6: number;
    p7: number; p8: number; p9: number; p10: number; p11: number;
  }
) {
  const machineId = scope.kind === "machine" ? scope.machineId : null;
  const projectId = scope.kind === "project" ? scope.projectId : null;
  return {
    machineId,
    projectId,
    a: entry ? entry.a : "",
    b: entry ? entry.b : 0,
    c: entry ? entry.c : false,
    bag,
    wide,
  };
}

declare const ipcMain: {
  handle: (channel: string, handler: (event: { sender: unknown; senderFrame: unknown }, url: string) => void) => void;
};
declare const shell: { openExternal: (url: string) => void };
ipcMain.handle("open-url", (_event, url) => {
  shell.openExternal(url);
});

export function badActivityReducer(
  state: { submitting: boolean; resending: boolean; googleSubmitting: boolean },
  action: { type: string }
) {
  switch (action.type) {
    case "submit":
      return { ...state, submitting: true, resending: false, googleSubmitting: false };
    case "resend":
      return { ...state, submitting: false, resending: true, googleSubmitting: false };
    default:
      return state;
  }
}

export function resolveChainedFallback(a?: string, b?: string, c?: string) {
  const viaTernary = a != null ? a : b != null ? b : c;
  const viaFind = [a, b, c].find(Boolean);
  return (a ?? b ?? c) || viaTernary || viaFind;
}

export function loadItemsSwallowingError(run: () => string[]): string[] {
  try {
    return run();
  } catch (caughtError) {
    console.error(caughtError);
    return [];
  }
}

export function upsertEntryTwoPass(
  entries: { id: string; label: string }[],
  next: { id: string; label: string }
) {
  return entries.some((entry) => entry.id === next.id)
    ? entries.map((entry) => (entry.id === next.id ? next : entry))
    : [...entries, next];
}

function LeafHeader({ title }: { title: string }) {
  return <span>{title}</span>;
}

export function DrillBanner({ title, active }: { title: string; active: boolean }) {
  const [shown, setShown] = useState(false);
  if (active && !shown) setShown(true);
  return <LeafHeader title={title} />;
}
`;

export const goodSource = `
${mergedShapeGoodSource}
import { useSyncExternalStore } from "react";
import { Text } from "@expo/ui/swift-ui";
import { z } from "zod";

export interface OrderSummary {
  readonly orderId: string;
  readonly totalCents: number;
}

export function formatOrderSummary(summary: OrderSummary): string {
  return \`\${summary.orderId}: \${summary.totalCents}\`;
}

export function isOrderReady(status: string, retryCount: number, hasOverride: boolean): boolean {
  return status === "ready" || retryCount === 0 || hasOverride;
}

export function resolveAuthoritativeLabel(label?: string): string {
  return label ?? "default-label";
}

export function CleanWidget(props: {
  a: string; b: string; c: string; d: string; e: string; f: string; g: string; h: string;
}) {
  "widget";
  const label = props.a;
  return <Text>{label}</Text>;
}

declare const ipcMain: {
  handle: (channel: string, handler: (event: { sender: unknown; senderFrame: unknown }, url: string) => void) => void;
};
declare const shell: { openExternal: (url: string) => void };
declare function isTrustedSender(sender: unknown): boolean;
ipcMain.handle("open-url-safe", (event, url) => {
  if (!isTrustedSender(event.sender)) {
    throw new Error("Untrusted sender");
  }
  shell.openExternal(url);
});
ipcMain.handle("open-url-positive", (event, url) => {
  if (isTrustedSender(event.sender)) {
    return shell.openExternal(url);
  }
});

const cachedSnapshot = { ready: true };
function getStableSnapshot() {
  return Object.assign(cachedSnapshot, { ready: true });
}

export function useReadySnapshot(subscribe: () => () => void) {
  return useSyncExternalStore(subscribe, getStableSnapshot);
}

const InputSchema = z.object({ id: z.string(), secret: z.string() });
const PublicSchema = z.object({ id: z.string() });
export const ProjectedSchema = InputSchema.transform((row) => ({
  id: row.id,
  redacted: true,
}));

export function parseTwoStage(raw: unknown) {
  const first = InputSchema.parse(raw);
  return PublicSchema.parse(first);
}

export function decodeBoundaryJson(rawText: string) {
  const boundaryRaw: unknown = JSON.parse(rawText);
  return PublicSchema.parse(boundaryRaw);
}

export const ClickEventSchema = z.object({ type: z.literal("click"), x: z.number() });
export const KeyEventSchema = z.object({ type: z.literal("key"), code: z.string() });
export const UiEventSchema = z.discriminatedUnion("type", [ClickEventSchema, KeyEventSchema]);
export const ClientClickSchema = ClickEventSchema.omit({ x: true }).extend({
  clientX: z.number(),
  clientY: z.number(),
});

export const ValidCustomSchema = z.custom<OrderSummary>(
  (candidate) =>
    typeof candidate === "object" &&
    candidate !== null &&
    "orderId" in candidate
);

export function isExitCodedFailure(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  return (
    ("exitCode" in failure && failure.exitCode === 2) ||
    ("code" in failure && failure.code === "ENOENT")
  );
}

export async function consumeStreamSafely(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done === true) break;
    }
  } finally {
    reader.releaseLock();
  }
}
`;

export const expectedRules = [
  "antidrift/no-structural-type-fork",
  "antidrift/no-compat-names",
  "antidrift/no-closed-string-parameter",
  "antidrift/no-mutable-let-alias",
  "antidrift/no-appeasement-cast",
  "antidrift/no-redundant-schema-parse",
  "antidrift/no-async-array-method",
  "antidrift/no-impure-render-call",
  "antidrift/no-unbound-widget-capture",
  "antidrift/no-raw-touchables",
  "antidrift/require-stable-snapshot",
  "antidrift/require-authz-check",
  "antidrift/no-handrolled-resource-lifecycle-cells",
  "antidrift/no-appeasement-erasure",
  "antidrift/no-anemic-errors",
  "antidrift/no-fallback-chain",
  "antidrift/no-sentinel-absence-fallback",
  "antidrift/no-branch-tree",
  "antidrift/no-pass-through-parameters",
  "antidrift/no-unresolved-dependency-types",
  "antidrift/no-contract-appeasement-projection",
  "antidrift/unknown-input-must-be-decoded",
  "antidrift/no-query-join-or-tree-reshape",
];

export const expectedDiagnostics = [
  {
    ruleId: "antidrift/no-structural-type-fork",
    message:
      "Type 'DuplicateExtended' duplicates the exact 2-field shape of 'FirstExtended'; reuse 'FirstExtended' instead of forking a parallel contract.",
  },
  {
    ruleId: "antidrift/no-structural-type-fork",
    message:
      "Union branches each restate the fields 'id: string', 'parentId: string'; factor them into one shared base and extend it per variant.",
  },
  {
    ruleId: "antidrift/no-query-join-or-tree-reshape",
    message:
      "Object literal reconciles overlapping fields across multiple entity representations ('summary.data' and 'detail.data'); normalize into one authoritative projection at the store or selector boundary.",
  },
  {
    ruleId: "antidrift/no-contract-appeasement-projection",
    message:
      "Assigns the same value to spelling-alias properties 'parentSessionId' and 'parentSessionID'; keep one canonical property name on the contract.",
  },
  {
    ruleId: "antidrift/no-contract-appeasement-projection",
    message:
      "Assigns the same value to spelling-alias properties 'parentSessionId' and 'parent_session_id'; keep one canonical property name on the contract.",
  },
  {
    ruleId: "antidrift/no-contract-appeasement-projection",
    message:
      "Object literal adapts 'thread' by copying its identity and padding 3 required fields with empty/placeholder constants; project a narrower view contract or union instead of fabricating missing entity state.",
  },
  {
    ruleId: "antidrift/no-query-join-or-tree-reshape",
    message:
      "Two or more reactive query collections are joined during render; move the join to the query select, store selector, or producer so render receives one typed projection.",
    count: 4,
  },
  {
    ruleId: "antidrift/no-branch-tree",
    message:
      "Discriminated union 'scope' is shredded into parallel nullable bindings; narrow 'scope' once via switch or a case table instead.",
  },
  {
    ruleId: "antidrift/no-branch-tree",
    message:
      "Nullable binding 'entry' is tested across 3+ ternaries in the same scope; narrow 'entry' once or use a resolved default object.",
  },
  {
    ruleId: "antidrift/no-branch-tree",
    message:
      "Branch tree has 5 arms; declare a typed case table instead of chaining if/else branches.",
  },
  {
    ruleId: "antidrift/no-sentinel-absence-fallback",
    message:
      "Optional-chain inequality against 0 evaluates to true when the chain short-circuits to undefined; use `(x?.length ?? 0) > 0` instead.",
  },
  {
    ruleId: "antidrift/no-sentinel-absence-fallback",
    message:
      'This fallback hides a missing member behind "unknown". Keep the missing value distinct from a reported value.',
  },
  {
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    message:
      "Module-scope 'let globalUiOpen' is mutated inside a React component or hook; move UI state into React state/context or a dedicated store.",
  },
  {
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    message:
      "Module-scope 'makeMutable' binding 'sharedProgress' shares mutable UI state across component instances; own the shared value inside a hook or context.",
  },
  {
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    message:
      "Reducer co-mutates >= 3 boolean activity flags as mutually exclusive phases; replace with a single discriminated phase union.",
  },
  {
    ruleId: "antidrift/no-pass-through-parameters",
    message:
      "Function parameter bag accepts 11 properties (max 10); group cohesive domain concepts or move behavior onto the owning object.",
  },
  {
    ruleId: "antidrift/no-pass-through-parameters",
    message:
      "Parameter bag accepts multiple foreign state callbacks (setA, setB, getC); return a state transition value or move the logic into the state owner.",
  },
  {
    ruleId: "antidrift/no-pass-through-parameters",
    message:
      "Parameter 'first' is only forwarded unchanged to 'combineLabels'. Resolve it at the leaf or pass a narrower domain object.",
  },
  {
    ruleId: "antidrift/no-unresolved-dependency-types",
    message:
      "Do not redeclare ambient 'process' types inline; import the typed environment owner or install the runtime types.",
  },
  {
    ruleId: "antidrift/no-structural-type-fork",
    message:
      "Type 'WorkspaceSidecarSlice' declares 3 parallel map fields (tabsByWorkspace, activeTabByWorkspace, expandedDirsByWorkspace) keyed by 'string'; consolidate per-key state into a single Map or Record of a domain entry type.",
  },
  {
    ruleId: "antidrift/no-compat-names",
    message:
      "Dual-key read 'input.taskId ?? input.task_id' probes both snake_case and camelCase spellings on the same receiver; normalize once at the boundary schema and read one canonical property.",
  },
  {
    ruleId: "antidrift/no-fallback-chain",
    message:
      "Chained fallback value selection across multiple candidate sources is forbidden; resolve one authoritative owner or decode once at the boundary.",
  },
  {
    ruleId: "antidrift/no-anemic-errors",
    message:
      "Failure path drops the error and returns an empty collection, which makes bad data look valid. Let the error propagate or return a typed failure.",
  },
  {
    ruleId: "antidrift/no-redundant-schema-parse",
    message:
      "Parameter 'entry' is already typed as a decoded schema output; do not re-parse internal typed values.",
  },
  {
    ruleId: "antidrift/no-query-join-or-tree-reshape",
    message:
      "Two-pass array upsert scans the collection with `.some()` / `.find()` and then re-scans with `.map()`; key the collection in a Map or update in a single pass.",
  },
  {
    ruleId: "antidrift/no-handrolled-resource-lifecycle-cells",
    message:
      "React state setter 'setShown' is called synchronously during render; derive the value during render instead of latching state.",
  },
  {
    ruleId: "antidrift/no-pass-through-parameters",
    message:
      "Parameter 'title' is only forwarded unchanged to 'LeafHeader'. Resolve it at the leaf or pass a narrower domain object.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not use `z.any()` in a boundary schema; validate the expected shape or use `z.unknown()` when the payload is intentionally opaque.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not call `z.custom()` without a validation predicate; bare `z.custom<T>()` accepts any value at runtime like an unchecked `as T` cast.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not chain `.transform()` directly on `z.unknown()`; validate the input schema before transforming or call a plain function instead of wrapping it in a no-op schema.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not decode caught exception 'caughtErr' with a boundary schema; narrow with `instanceof Error` (and `'code' in caughtErr`) or handle expected exit statuses at the process boundary.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not include `z.unknown()` as a branch of `z.union([...])`; an unvalidated branch absorbs every validation failure and widens the union to untyped input.",
  },
  {
    ruleId: "antidrift/unknown-input-must-be-decoded",
    message:
      "Do not coerce split string tokens with unchecked `Number(...)` in `.map()` (which silently produces `NaN` on non-numeric output); validate numeric tokens explicitly or decode with a boundary schema.",
  },
  {
    ruleId: "antidrift/no-anemic-errors",
    message:
      "Catch block branches on 'caughtErr' message substring 'ENOENT'; match a typed error class (`instanceof`), structured `.code` field, or domain variant instead of substring probing.",
  },
];
