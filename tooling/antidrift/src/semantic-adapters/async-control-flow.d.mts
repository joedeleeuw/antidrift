export type AsyncArrayCallbackKind =
  | "never-await"
  | "requires-collection";

export interface AsyncArrayCallbackClassification {
  callback: unknown;
  method: string;
  kind: AsyncArrayCallbackKind;
}

export interface PendingAsyncMap {
  variable: unknown;
  node: unknown;
  method: string;
  awaited: boolean;
}

export const ASYNC_ARRAY_METHODS_REQUIRE_COLLECTION: Set<string>;
export const ASYNC_ARRAY_METHODS_NEVER_AWAIT: Set<string>;
export const PROMISE_COMBINATOR_METHODS: Set<string>;

export function isPromiseCombinator(callee: unknown): boolean;

export function getDeclaredVariable(
  sourceCode: unknown,
  declarator: unknown,
): unknown | null;

export function findVariable(
  sourceCode: unknown,
  identifier: unknown,
): unknown | null;

export function promiseCombinatorVariables(
  sourceCode: unknown,
  node: unknown,
): unknown[];

export function asyncCallbackArgument(node: unknown): unknown | null;

export function asyncArrayCallbackClassification(
  node: unknown,
): AsyncArrayCallbackClassification | null;

export function markAwaitedPendingMaps(
  sourceCode: unknown,
  node: unknown,
  pendingAsyncMaps: PendingAsyncMap[],
): void;

export function isDirectlyWrappedInPromiseCombinator(node: unknown): boolean;

export function queuePendingAsyncMap(
  sourceCode: unknown,
  node: unknown,
  callback: unknown,
  method: string,
  pendingAsyncMaps: PendingAsyncMap[],
): boolean;
