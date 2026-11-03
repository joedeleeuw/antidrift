export const badSource = `
import { useSyncExternalStore } from "react";
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
`;

export const goodSource = `
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
  "antidrift/no-unknown-type-aliases",
  "antidrift/no-redeclared-owned-union",
  "antidrift/no-structural-type-fork",
  "antidrift/no-compat-names",
  "antidrift/no-closed-string-parameter",
  "antidrift/no-mutable-let-alias",
  "antidrift/no-else-if-chain",
  "antidrift/no-unsafe-deserialize",
  "antidrift/no-unsafe-cast-chain",
  "antidrift/no-redundant-zod-parse",
  "antidrift/no-async-array-method",
  "antidrift/no-unstable-render-default-collection",
  "antidrift/no-impure-render-call",
  "antidrift/no-unbound-widget-capture",
  "antidrift/no-raw-react-native-touchables",
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
  "antidrift/no-nullable-positional-tuple",
  "antidrift/unknown-input-must-be-decoded",
  "antidrift/no-query-join-or-tree-reshape",
];

export const expectedDiagnostics = [
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
    ruleId: "antidrift/no-redundant-zod-parse",
    message:
      "Parameter 'entry' is already typed as a decoded schema output; do not re-parse internal typed values.",
  },
];
