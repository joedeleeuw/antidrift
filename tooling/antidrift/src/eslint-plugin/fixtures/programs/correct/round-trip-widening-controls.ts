type Created = { kind: "created"; id: string };
type Deleted = { kind: "deleted"; id: string; reason: string };
type Renamed = { kind: "renamed"; id: string; name: string };
type ChangeEvent = Created | Deleted | Renamed;

// Dispatcher: the callers jointly pass every member, so the switch is a real dispatch.
function describeChange(change: ChangeEvent): string {
  switch (change.kind) {
    case "created":
      return change.id;
    case "deleted":
      return change.reason;
    case "renamed":
      return change.name;
  }
}
export function replayChanges(
  created: Created,
  deleted: Deleted,
  renamed: Renamed
) {
  return [
    describeChange(created),
    describeChange(deleted),
    describeChange(renamed),
  ];
}

// Optional parameter with a default: some callers omit it.
type RetryOptions = { retries: number };
function requestWith(url: string, options?: RetryOptions) {
  const resolved = options ?? { retries: 1 };
  return `${url}:${resolved.retries}`;
}
export const firstRequest = requestWith("a", { retries: 3 });
export const secondRequest = requestWith("b");

// Type-predicate implementation: it is the boundary that proves the type.
function isCreated(candidate: ChangeEvent | null): candidate is Created {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.kind === "created"
  );
}
export function createdOnly(changes: readonly Created[]) {
  return changes.filter((change) => isCreated(change));
}

// Generic walker: producers supply what each probe distinguishes.
function collectLeaves(node: unknown, found: string[]): void {
  if (typeof node === "string") {
    found.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectLeaves(child, found);
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const child of Object.values(node)) collectLeaves(child, found);
  }
}
export function leavesOf(document: unknown) {
  const found: string[] = [];
  collectLeaves(document, found);
  return found;
}

// Identity reference: a handler passed as a value has callers out of view.
function onPayload(payload: unknown) {
  return typeof payload === "string" ? payload : "";
}
declare const emitter: {
  on(event: string, listener: (payload: unknown) => string): void;
};
emitter.on("payload", onPayload);
export const directPayload = onPayload("hello");

// Exported with no caller in this program: its callers are out of view.
export function publicLabel(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

// Nullish-only recovery: the check removes undefined, not anything the
// contract dropped from its producers.
type Session = { token: string };
function tokenOf(session: Session | undefined) {
  return session instanceof Object ? session.token : "";
}
export const sessionToken = tokenOf({ token: "t" });

// A record view of an object contract re-derives nothing: every object is a
// string-keyed record, so the view is not narrower than `object`.
interface Slide {
  id: string;
  content: string;
}
function hasChangedFields(current: object, fields: object): boolean {
  const currentRecord = current as Record<string, unknown>;
  const fieldRecord = fields as Record<string, unknown>;
  return Object.keys(fieldRecord).some(
    (key) => currentRecord[key] !== fieldRecord[key]
  );
}
export function slideChanged(slide: Slide, fields: Partial<Slide>) {
  return hasChangedFields(slide, fields);
}

// The annotation equals the inferred type: nothing is dropped.
export function identityAnnotation() {
  const sender: { name: string; agent: string } = { name: "n", agent: "a" };
  return typeof sender.name === "string" ? sender.name : "";
}

// A lookup table keyed at runtime: the recovery is a real check on a value the
// producers left open.
export function translate(key: string) {
  const table: Record<string, unknown> = { greeting: "hello", count: 3 };
  const entry = table[key];
  return typeof entry === "string" ? entry : key;
}

// An accumulator whose writes include values the recovery excludes.
export function mixedProperties(extra: boolean) {
  const properties: Record<string, unknown> = { label: { type: "string" } };
  if (extra) properties.count = 3;
  return properties as Record<string, Record<string, unknown>>;
}

// A switch over a contract the caller passes whole: each case dispatches; none
// re-derives a member a producer supplied.
type SubmitMessage = { type: "submit"; input: string };
type AbortMessage = { type: "abort" };
type ClientMessage = SubmitMessage | AbortMessage;
function handleMessage(message: ClientMessage): string {
  switch (message.type) {
    case "submit":
      return message.input;
    case "abort":
      return "";
  }
}
export function receiveMessage(message: ClientMessage) {
  return handleMessage(message);
}

// A condition on one element says nothing about the next one.
type PathToken = string | number;
function createPath(root: Record<string, unknown>, tokens: PathToken[]) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (typeof token === "number") {
      root[String(token)] = typeof nextToken === "number" ? [] : {};
    }
  }
}
export function createFirstPath(
  root: Record<string, unknown>,
  tokens: PathToken[]
) {
  createPath(root, tokens);
}

// A cast that only lets a write through adds a member, and the other branch
// writes a different value there.
type StandardConfig = { agents: string[]; type?: "standard" };
type MultiConfig = { agents: string[]; edges?: string[]; type?: "multi" };
type LegacyConfig = { legacy: true };
export function buildConfig(agents: string[], multi: boolean) {
  const config: StandardConfig | MultiConfig | LegacyConfig = { agents };
  if (multi) {
    (config as unknown as MultiConfig).type = "multi";
  } else {
    (config as StandardConfig).type = "standard";
  }
  return config;
}

// A generic merge writes keys the type parameter does not promise, so its
// cast back is not a round trip.
function mergeInto<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    result[key] = source[key];
  }
  return result as T;
}
export const mergedSettings = mergeInto({ theme: "dark" }, { size: 2 });

// `{}` admits primitives: a non-nullish value is not yet a record.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function describeOutput(output: unknown): string {
  return isRecord(output) ? Object.keys(output).join(",") : String(output);
}
export function outputLabel(output: unknown) {
  return output === null || output === undefined ? "" : describeOutput(output);
}

// A key some producers never declare: the cast asserts it rather than
// re-deriving it.
type TextMessagePart = { type: "text"; text: string };
type ToolMessagePart = {
  type: "tool";
  toolCallId: string;
  approval?: { approved: boolean };
};
export function approvalsOf(
  parts: ReadonlyArray<TextMessagePart | ToolMessagePart>
) {
  const found: unknown[] = [];
  for (const part of parts) {
    const record = part as Record<string, unknown>;
    const approval = record.approval as { approved?: unknown } | undefined;
    if (approval) found.push(approval.approved);
  }
  return found;
}

// A cast to an all-optional shape probes one driver's result; the other
// driver's result shares no key with it, so it does not pass vacuously.
type LibsqlResult = { rowsAffected: number };
type PostgresResult = { rowCount: number };
function affectedRowCount(result: unknown): number {
  return (
    (result as { rowsAffected?: number }).rowsAffected ??
    (result as { rowCount?: number }).rowCount ??
    0
  );
}
export function affectedTotal(libsql: LibsqlResult, postgres: PostgresResult) {
  return affectedRowCount(libsql) + affectedRowCount(postgres);
}
