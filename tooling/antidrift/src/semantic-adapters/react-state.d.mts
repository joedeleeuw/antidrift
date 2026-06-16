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
  paramNames: Set<string>;
  setters: Set<string>;
  cellOf: Map<string, string>;
  awaitedNames: Set<string>;
  writes: Map<string, Set<ReactStateWriteClass>>;
  called: Set<string>;
  isTransition: boolean;
  requestGuard: boolean;
  sourceMemberWrites: ReactStateSourceMemberWrite[];
  sourceMemberTransitions: ReactStateSourceMemberTransition[];
  eventEditedCells: Set<string>;
  controlledCells: Set<string>;
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

export interface ReactStateSourceMemberWrite {
  setter: string;
  cell: string;
  source: string;
  property: string;
}

export interface ReactStateSourceMemberTransition {
  source: string;
  entries: ReactStateSourceMemberWrite[];
  node: unknown;
  transition: boolean;
  requestGuard: boolean;
}

export interface ReactStateSourceShardProof {
  source?: string;
  sourceInit?: unknown;
  entries: ReactStateSourceMemberWrite[];
  editableCells: string[];
  node?: unknown;
  transition?: boolean;
  requestGuard?: boolean;
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

export function sourceShardProof(
  frame: ReactStateFrame,
  options?: { threshold?: number },
): ReactStateSourceShardProof;

export function frameStatePayload(
  frame: ReactStateFrame,
): ReactStateFramePayload;
