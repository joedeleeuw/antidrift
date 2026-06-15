export type ReactStateWriteClass =
  | "trueConst"
  | "falseConst"
  | "nullConst"
  | "awaited"
  | "caughtError"
  | "updater"
  | "other";

export interface ReactStateWriteContext {
  awaitedNames: ReadonlySet<string>;
  catchParams: readonly (string | null)[];
}

export interface ReactStateFrame {
  node: unknown;
  setters: Set<string>;
  cellOf: Map<string, string>;
  awaitedNames: Set<string>;
  writes: Map<string, Set<ReactStateWriteClass>>;
  called: Set<string>;
  isTransition: boolean;
  requestGuard: boolean;
  ownerSetters?: Set<string>;
}

export interface ReactStateTracker {
  visitors: Record<string, (node: unknown) => void>;
}

export interface ReactStateCellPayload {
  cell: string | null;
  writes: ReactStateWriteClass[];
}

export interface ReactStateFramePayload {
  transition: boolean;
  requestGuard: boolean;
  setterCount: number;
  cells: Record<string, ReactStateCellPayload>;
}

export interface ReactStateLifecycleProof {
  boolCell: string | null;
  errorCell: string | null;
  payloadCell: string | null;
  proven: boolean;
}

export function classifyWriteValue(
  arg: unknown,
  context: ReactStateWriteContext,
): ReactStateWriteClass | null;

export function createReactStateTracker(options?: {
  onFrameExit?: (frame: ReactStateFrame) => void;
}): ReactStateTracker;

export function lifecycleProof(
  frame: ReactStateFrame,
): ReactStateLifecycleProof;

export function frameStatePayload(
  frame: ReactStateFrame,
): ReactStateFramePayload;
