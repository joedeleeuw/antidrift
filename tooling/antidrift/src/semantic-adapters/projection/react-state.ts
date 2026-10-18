import { isInlineFunction } from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
} from "../kernel/syntax-node.ts";
import type {
  AbortControllerScope,
  AbortStatusGuard,
} from "./react-abort-guards.ts";
import {
  abortControllerDeclaration,
  abortStatusGuards,
  hasAbortStatusGuardFor,
} from "./react-abort-guards.ts";
import { ReactHookBindings } from "./react-hook-bindings.ts";
import {
  castIdentifierName,
  isParameterDerived,
  parameterNames,
  sourceMemberWrite,
  unwrapCasts,
} from "./react-state-syntax.ts";

export type ReactStateWriteClass =
  | "trueConst"
  | "falseConst"
  | "nullConst"
  | "awaited"
  | "caughtError"
  | "updater"
  | "other";

export type ReactStateWriteContext = {
  readonly awaitedNames: ReadonlySet<string>;
  readonly catchParams: readonly (string | null)[];
};

export type ReactStateSourceMemberWrite = {
  readonly source: string;
  readonly property: string;
  readonly setter: string;
  readonly cell: string;
};

export type ReactStateSourceMemberTransition = {
  readonly source: string;
  readonly sourceInit: unknown;
  readonly entries: readonly ReactStateSourceMemberWrite[];
  readonly node: unknown;
  readonly transition: boolean;
  readonly requestGuard: boolean;
};

export type ReactStateFrame = {
  readonly node: unknown;
  readonly paramNames: ReadonlySet<string>;
  readonly setters: Set<string>;
  readonly cellOf: Map<string, string>;
  readonly awaitedNames: Set<string>;
  readonly awaitedSourceInits: Map<string, unknown>;
  readonly writes: Map<string, Set<ReactStateWriteClass>>;
  readonly called: Set<string>;
  isTransition: boolean;
  requestGuard: boolean;
  readonly sourceMemberWrites: ReactStateSourceMemberWrite[];
  readonly sourceMemberTransitions: ReactStateSourceMemberTransition[];
  readonly eventEditedCells: Set<string>;
  readonly controlledCells: Set<string>;
  readonly catchSetters: Set<string>;
  readonly updaterSetters: Set<string>;
  readonly abortControllers: Set<string>;
  readonly abortControllerRefs: Set<string>;
  readonly abortStatusGuards: AbortStatusGuard[];
  readonly abortGuardedSetters: Set<string>;
  ownerSetters?: ReadonlySet<string>;
};

export type ReactStateLifecycleProof = {
  readonly boolCell: string | null;
  readonly errorCell: string | null;
  readonly payloadCell: string | null;
  readonly proven: boolean;
};

export type ReactStateSourceShardProof =
  | (ReactStateSourceMemberTransition & {
      readonly editableCells: readonly string[];
      readonly proven: true;
    })
  | {
      readonly entries: readonly ReactStateSourceMemberWrite[];
      readonly editableCells: readonly string[];
      readonly proven: false;
    };

export type ReactStateCellPayload = {
  readonly cell: string | null;
  readonly writes: readonly ReactStateWriteClass[];
};

export type ReactStateFramePayload = {
  readonly transition: boolean;
  readonly requestGuard: boolean;
  readonly setterCount: number;
  readonly cells: Readonly<Record<string, ReactStateCellPayload>>;
};

export type ReactStateTrackerContext = {
  readonly sourceCode?: unknown;
  readonly getSourceCode?: () => unknown;
};

export type ReactStateTrackerOptions = {
  readonly context?: ReactStateTrackerContext;
  readonly sourceCode?: unknown;
  readonly onFrameExit?: (frame: ReactStateFrame) => void;
};

const LITERAL_WRITE_CLASSES = new Map<unknown, ReactStateWriteClass>([
  [true, "trueConst"],
  [false, "falseConst"],
  [null, "nullConst"],
]);

export function classifyStateWrite(
  argument: unknown,
  { awaitedNames, catchParams }: ReactStateWriteContext
): ReactStateWriteClass | null {
  const written = unwrapCasts(argument);
  if (written === null || written === undefined) {
    return null;
  }
  if (isInlineFunction(written)) {
    return "updater";
  }
  if (isSyntaxType(written, "Literal")) {
    return LITERAL_WRITE_CLASSES.get(syntaxField(written, "value")) ?? "other";
  }
  const name = identifierName(written);
  if (name === "undefined") {
    return "nullConst";
  }
  if (
    isSyntaxType(written, "AwaitExpression") ||
    (name !== null && awaitedNames.has(name))
  ) {
    return "awaited";
  }
  return name !== null && catchParams.includes(name) ? "caughtError" : "other";
}

function sortedNames<Name extends string>(names: Iterable<Name>): Name[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function lifecycleProof(
  frame: ReactStateFrame
): ReactStateLifecycleProof {
  const owned = frame.ownerSetters ?? frame.setters;
  if ([...frame.updaterSetters].some((setter) => owned.has(setter))) {
    return {
      boolCell: null,
      errorCell: null,
      payloadCell: null,
      proven: false,
    };
  }
  const entries = [...frame.writes].filter(([setter]) => owned.has(setter));
  const boolCell =
    entries.find(
      ([, classes]) => classes.has("trueConst") && classes.has("falseConst")
    )?.[0] ?? null;
  const errorCell = boolCell
    ? ([...frame.catchSetters].find(
        (name) => name !== boolCell && owned.has(name)
      ) ?? null)
    : null;
  const blocked = new Set([boolCell, errorCell]);
  const directPayloadCell = errorCell
    ? (entries.find(
        ([name, classes]) => !blocked.has(name) && classes.has("awaited")
      )?.[0] ?? null)
    : null;
  const sourcePayloadCell = errorCell
    ? (frame.sourceMemberWrites.find(
        (write) => owned.has(write.setter) && !blocked.has(write.setter)
      )?.setter ?? null)
    : null;
  const payloadCell = directPayloadCell ?? sourcePayloadCell;
  return { boolCell, errorCell, payloadCell, proven: Boolean(payloadCell) };
}

export function sourceShardProof(
  frame: ReactStateFrame,
  { threshold = 2 }: { readonly threshold?: number } = {}
): ReactStateSourceShardProof {
  const editableCells = new Set(
    [...frame.eventEditedCells].filter((cell) =>
      frame.controlledCells.has(cell)
    )
  );
  for (const transition of frame.sourceMemberTransitions) {
    const byCell = new Map(
      transition.entries
        .filter((entry) => !editableCells.has(entry.cell))
        .map((entry): [string, ReactStateSourceMemberWrite] => [
          entry.cell,
          entry,
        ])
    );
    const entries = [...byCell.values()];
    const properties = new Set(entries.map((entry) => entry.property));
    if (
      transition.transition &&
      entries.length >= threshold &&
      properties.size >= threshold
    ) {
      return {
        ...transition,
        entries,
        editableCells: sortedNames(editableCells),
        proven: true,
      };
    }
  }
  return {
    entries: [],
    editableCells: sortedNames(editableCells),
    proven: false,
  };
}

export function frameStatePayload(
  frame: ReactStateFrame
): ReactStateFramePayload {
  const cells: Record<string, ReactStateCellPayload> = {};
  for (const [setter, classes] of frame.writes) {
    cells[setter] = {
      cell: frame.cellOf.get(setter) ?? null,
      writes: sortedNames(classes),
    };
  }
  return {
    transition: frame.isTransition,
    requestGuard: frame.requestGuard,
    setterCount: frame.called.size,
    cells,
  };
}

function createFrame(node: unknown): ReactStateFrame {
  return {
    node,
    paramNames: parameterNames(node),
    setters: new Set(),
    cellOf: new Map(),
    awaitedNames: new Set(),
    awaitedSourceInits: new Map(),
    writes: new Map(),
    called: new Set(),
    isTransition: false,
    requestGuard: false,
    sourceMemberWrites: [],
    sourceMemberTransitions: [],
    eventEditedCells: new Set(),
    controlledCells: new Set(),
    catchSetters: new Set(),
    updaterSetters: new Set(),
    abortControllers: new Set(),
    abortControllerRefs: new Set(),
    abortStatusGuards: [],
    abortGuardedSetters: new Set(),
  };
}

function sourceMemberTransitions(
  frame: ReactStateFrame
): ReactStateSourceMemberTransition[] {
  const writesBySource = new Map<string, ReactStateSourceMemberWrite[]>();
  for (const write of frame.sourceMemberWrites) {
    const writes = writesBySource.get(write.source) ?? [];
    writes.push(write);
    writesBySource.set(write.source, writes);
  }
  return [...writesBySource].map(([source, entries]) => ({
    source,
    sourceInit: frame.awaitedSourceInits.get(source) ?? null,
    entries,
    node: frame.node,
    transition: frame.isTransition,
    requestGuard: frame.requestGuard,
  }));
}

class ReactStateTraversal implements AbortControllerScope {
  readonly #hooks: ReactHookBindings;
  readonly #onFrameExit: ((frame: ReactStateFrame) => void) | undefined;
  readonly #functionStack: ReactStateFrame[] = [];
  readonly #catchParams: (string | null)[] = [];

  constructor(
    hooks: ReactHookBindings,
    onFrameExit: ((frame: ReactStateFrame) => void) | undefined
  ) {
    this.#hooks = hooks;
    this.#onFrameExit = onFrameExit;
  }

  isAbortController(name: string): boolean {
    return this.#functionStack.some((frame) =>
      frame.abortControllers.has(name)
    );
  }

  isAbortControllerRef(name: string): boolean {
    return this.#functionStack.some((frame) =>
      frame.abortControllerRefs.has(name)
    );
  }

  enterFunction(node: unknown): void {
    this.#functionStack.push(createFrame(node));
  }

  exitFunction(): void {
    const frame = this.#functionStack.pop();
    if (!frame) {
      return;
    }
    const parent = this.#functionStack.at(-1);
    frame.ownerSetters = parent
      ? new Set([...frame.setters, ...parent.setters])
      : frame.setters;
    const payloadCell = frame.isTransition
      ? lifecycleProof(frame).payloadCell
      : null;
    frame.requestGuard =
      payloadCell !== null && frame.abortGuardedSetters.has(payloadCell);
    frame.sourceMemberTransitions.push(...sourceMemberTransitions(frame));
    if (parent) {
      for (const cell of frame.eventEditedCells) {
        parent.eventEditedCells.add(cell);
      }
      for (const cell of frame.controlledCells) {
        parent.controlledCells.add(cell);
      }
      parent.sourceMemberTransitions.push(...frame.sourceMemberTransitions);
    }
    this.#onFrameExit?.(frame);
  }

  enterCatch(clause: unknown): void {
    this.#catchParams.push(identifierName(syntaxField(clause, "param")));
  }

  exitCatch(): void {
    this.#catchParams.pop();
  }

  markTransition(): void {
    const frame = this.#functionStack.at(-1);
    if (frame) {
      frame.isTransition = true;
    }
  }

  ifStatement(statement: unknown): void {
    this.#functionStack
      .at(-1)
      ?.abortStatusGuards.push(...abortStatusGuards(statement, this));
  }

  jsxAttribute(attribute: unknown): void {
    const frame = this.#functionStack.at(-1);
    const attributeName = syntaxField(syntaxField(attribute, "name"), "name");
    const container = syntaxField(attribute, "value");
    const cell = isSyntaxType(container, "JSXExpressionContainer")
      ? castIdentifierName(syntaxField(container, "expression"))
      : "";
    if (
      frame &&
      (attributeName === "value" || attributeName === "checked") &&
      cell &&
      this.#functionStack.some((scope) =>
        [...scope.cellOf.values()].includes(cell)
      )
    ) {
      frame.controlledCells.add(cell);
    }
  }

  variableDeclarator(declarator: unknown): void {
    const frame = this.#functionStack.at(-1);
    if (!frame) {
      return;
    }
    const init = unwrapCasts(syntaxField(declarator, "init"));
    const id = syntaxField(declarator, "id");
    const name = identifierName(id);
    const abortKind = abortControllerDeclaration(init, this.#hooks);
    if (name !== null && abortKind === "controller") {
      frame.abortControllers.add(name);
    }
    if (name !== null && abortKind === "ref") {
      frame.abortControllerRefs.add(name);
    }
    if (
      isSyntaxType(init, "CallExpression") &&
      this.#hooks.isHookCallee(syntaxField(init, "callee"), "useState") &&
      isSyntaxType(id, "ArrayPattern")
    ) {
      const [cell, setter] = syntaxChildren(id, "elements");
      const setterName = identifierName(setter);
      const cellName = identifierName(cell);
      if (setterName !== null) {
        frame.setters.add(setterName);
      }
      if (setterName !== null && cellName !== null) {
        frame.cellOf.set(setterName, cellName);
      }
    }
    if (name !== null && isSyntaxType(init, "AwaitExpression")) {
      frame.awaitedNames.add(name);
      frame.awaitedSourceInits.set(name, init);
    }
  }

  callExpression(call: unknown): void {
    const frame = this.#functionStack.at(-1);
    const setter = identifierName(syntaxField(call, "callee"));
    if (
      !frame ||
      setter === null ||
      !this.#functionStack.some((scope) => scope.setters.has(setter))
    ) {
      return;
    }
    frame.called.add(setter);
    if (hasAbortStatusGuardFor(frame.abortStatusGuards, call)) {
      frame.abortGuardedSetters.add(setter);
    }
    if (this.#catchParams.length > 0) {
      frame.catchSetters.add(setter);
    }
    const [argument] = syntaxChildren(call, "arguments");
    if (argument) {
      this.#recordSetterArgument(frame, setter, argument);
    }
  }

  #recordSetterArgument(
    frame: ReactStateFrame,
    setter: string,
    argument: unknown
  ): void {
    const cell =
      frame.cellOf.get(setter) ??
      this.#functionStack
        .findLast((scope) => scope.cellOf.get(setter))
        ?.cellOf.get(setter) ??
      null;
    if (cell && !frame.cellOf.has(setter)) {
      frame.cellOf.set(setter, cell);
    }
    if (cell && isParameterDerived(argument, frame.paramNames)) {
      frame.eventEditedCells.add(cell);
    }
    const sourceWrite = sourceMemberWrite(argument, frame.awaitedNames);
    if (sourceWrite && cell) {
      frame.sourceMemberWrites.push({ ...sourceWrite, setter, cell });
    }
    const writeClass = classifyStateWrite(argument, {
      awaitedNames: frame.awaitedNames,
      catchParams: this.#catchParams,
    });
    if (writeClass === "updater") {
      frame.updaterSetters.add(setter);
    }
    if (
      writeClass === null ||
      writeClass === "updater" ||
      writeClass === "other"
    ) {
      return;
    }
    const classes = frame.writes.get(setter) ?? new Set<ReactStateWriteClass>();
    classes.add(writeClass);
    frame.writes.set(setter, classes);
  }
}

export function createReactStateTracker({
  context,
  onFrameExit,
  sourceCode,
}: ReactStateTrackerOptions = {}) {
  const eslintSourceCode =
    sourceCode ?? context?.sourceCode ?? context?.getSourceCode?.();
  if (!eslintSourceCode) {
    throw new Error("createReactStateTracker requires ESLint sourceCode.");
  }
  const hooks = new ReactHookBindings(eslintSourceCode);
  const traversal = new ReactStateTraversal(hooks, onFrameExit);
  const enterFunction = (node: unknown) => traversal.enterFunction(node);
  const exitFunction = () => traversal.exitFunction();
  const markTransition = () => traversal.markTransition();
  return {
    visitors: {
      ImportDeclaration: (node: unknown) => hooks.recordImport(node),
      VariableDeclarator: (node: unknown) => traversal.variableDeclarator(node),
      AwaitExpression: markTransition,
      TryStatement: markTransition,
      IfStatement: (node: unknown) => traversal.ifStatement(node),
      JSXAttribute: (node: unknown) => traversal.jsxAttribute(node),
      CatchClause: (node: unknown) => traversal.enterCatch(node),
      "CatchClause:exit": () => traversal.exitCatch(),
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression: (node: unknown) => traversal.callExpression(node),
    },
  };
}

export type ReactStateTracker = ReturnType<typeof createReactStateTracker>;
