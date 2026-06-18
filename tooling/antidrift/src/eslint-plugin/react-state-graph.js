// React-state semantic adapter.
//
// Turns ESLint AST traversal into a per-function "frame" that carries the React
// state graph: useState cell<->setter bindings, setter writes classified by VALUE
// BEHAVIOR (never by identifier name), and async-transition facts. Rules consume
// frames and ask questions over them; they never match names like data/loading/error.
//
// This is the substrate that makes resource-lifecycle rules workable: the same
// frames feed every consumer.

function unwrapCasts(node) {
  let current = node;
  while (current) {
    if (
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ChainExpression"
    ) {
      current = current.expression;
    } else {
      break;
    }
  }
  return current;
}

// Behavior-classification of a setter-call argument. Roles come from what the value
// IS, not what the cell is named. Numeric/string literals are domain values, not
// lifecycle constants, so they classify as "other".
export function classifyWriteValue(arg, { awaitedNames, catchParams }) {
  const value = unwrapCasts(arg);
  if (!value) return null;
  if (
    value.type === "ArrowFunctionExpression" ||
    value.type === "FunctionExpression"
  ) {
    return "updater";
  }
  if (value.type === "Literal" && value.value === true) return "trueConst";
  if (value.type === "Literal" && value.value === false) return "falseConst";
  if (value.type === "Literal" && value.value === null) return "nullConst";
  if (value.type === "Identifier" && value.name === "undefined") {
    return "nullConst";
  }
  if (value.type === "AwaitExpression") return "awaited";
  if (value.type === "Identifier" && awaitedNames.has(value.name)) {
    return "awaited";
  }
  if (value.type === "Identifier" && catchParams.includes(value.name)) {
    return "caughtError";
  }
  return "other";
}

function memberName(node) {
  return !node?.computed && node?.property?.type === "Identifier"
    ? node.property.name
    : "";
}

function staticMemberName(node) {
  if (!node) return "";
  if (!node.computed) return memberName(node);
  const property = unwrapCasts(node.property);
  if (
    property?.type === "Literal" &&
    (typeof property.value === "string" || typeof property.value === "number")
  ) {
    return String(property.value);
  }
  return "";
}

function identifierName(node) {
  const value = unwrapCasts(node);
  return value?.type === "Identifier" ? value.name : "";
}

function paramNames(params = []) {
  return new Set(
    params
      .map((param) => identifierName(param))
      .filter((name) => name.length > 0),
  );
}

function baseIdentifierName(node) {
  const value = unwrapCasts(node);
  if (value?.type === "Identifier") return value.name;
  if (value?.type === "MemberExpression") {
    return baseIdentifierName(value.object);
  }
  return "";
}

function importedName(specifier) {
  const imported = specifier?.imported;
  if (imported?.type === "Identifier") return imported.name;
  if (imported?.type === "Literal") return String(imported.value);
  return "";
}

function isNewAbortController(node) {
  const value = unwrapCasts(node);
  return (
    value?.type === "NewExpression" &&
    value.callee?.type === "Identifier" &&
    value.callee.name === "AbortController"
  );
}

// Only first-level member access on the awaited source (`source.prop`) is a shard
// write; deeper access (`source.a.b`) is not attributed to `source`, so a leaf name
// that happens to match an owner property cannot be mis-counted as a fanned member.
function sourceMemberWrite(arg, awaitedNames) {
  const value = unwrapCasts(arg);
  if (value?.type !== "MemberExpression") return null;
  const object = unwrapCasts(value.object);
  if (object?.type !== "Identifier") return null;
  const property = staticMemberName(value);
  if (!object.name || !property || !awaitedNames.has(object.name)) return null;
  return { source: object.name, property };
}

function isParamDerivedValue(node, names) {
  const value = unwrapCasts(node);
  if (!value) return false;
  if (value.type === "Identifier") return names.has(value.name);
  if (value.type === "MemberExpression") {
    return names.has(baseIdentifierName(value.object));
  }
  if (value.type === "CallExpression") {
    return value.arguments.some((arg) => isParamDerivedValue(arg, names));
  }
  if (value.type === "TemplateLiteral") {
    return value.expressions.some((expr) => isParamDerivedValue(expr, names));
  }
  if (value.type === "LogicalExpression" || value.type === "BinaryExpression") {
    return (
      isParamDerivedValue(value.left, names) ||
      isParamDerivedValue(value.right, names)
    );
  }
  if (value.type === "ConditionalExpression") {
    return (
      isParamDerivedValue(value.test, names) ||
      isParamDerivedValue(value.consequent, names) ||
      isParamDerivedValue(value.alternate, names)
    );
  }
  return false;
}

function sourceMemberTransitions(frame) {
  const bySource = new Map();
  for (const write of frame.sourceMemberWrites) {
    const entries = bySource.get(write.source) ?? [];
    entries.push(write);
    bySource.set(write.source, entries);
  }
  return [...bySource.entries()].map(([source, entries]) => ({
    source,
    sourceInit: frame.awaitedSourceInits.get(source) ?? null,
    entries,
    node: frame.node,
    transition: Boolean(frame.isTransition),
    requestGuard: frame.requestGuard,
  }));
}

export function createReactStateTracker({ onFrameExit } = {}) {
  const functionStack = [];
  const catchParams = [];
  const reactObjectLocals = new Set();
  const reactHookLocals = new Map([
    ["useRef", new Set()],
    ["useState", new Set()],
  ]);
  const top = () => functionStack[functionStack.length - 1] ?? null;
  const setterInScope = (name) =>
    functionStack.some((frame) => frame.setters.has(name));
  const cellInScope = (name) =>
    functionStack.some((frame) => [...frame.cellOf.values()].includes(name));
  const abortControllerInScope = (name) =>
    functionStack.some((frame) => frame.abortControllers.has(name));
  const abortControllerRefInScope = (name) =>
    functionStack.some((frame) => frame.abortControllerRefs.has(name));
  // A setter's cell is declared in the owning component frame, but its writes happen
  // in a nested transition frame, so resolve the binding up the stack.
  const cellFor = (name) => {
    for (let depth = functionStack.length - 1; depth >= 0; depth -= 1) {
      const cell = functionStack[depth].cellOf.get(name);
      if (cell) return cell;
    }
    return null;
  };

  function isReactHookCallee(callee, hookName) {
    const value = unwrapCasts(callee);
    if (value?.type === "Identifier") {
      return reactHookLocals.get(hookName)?.has(value.name) ?? false;
    }
    if (value?.type !== "MemberExpression" || memberName(value) !== hookName) {
      return false;
    }
    const object = unwrapCasts(value.object);
    return object?.type === "Identifier" && reactObjectLocals.has(object.name);
  }

  function isAbortControllerRefInit(node) {
    const value = unwrapCasts(node);
    return (
      value?.type === "CallExpression" &&
      isReactHookCallee(value.callee, "useRef") &&
      isNewAbortController(value.arguments?.[0])
    );
  }

  function isAbortControllerCurrent(node) {
    const value = unwrapCasts(node);
    if (value?.type !== "MemberExpression" || memberName(value) !== "current") {
      return false;
    }
    const object = unwrapCasts(value.object);
    return (
      object?.type === "Identifier" && abortControllerRefInScope(object.name)
    );
  }

  function isKnownAbortController(node) {
    const value = unwrapCasts(node);
    return (
      (value?.type === "Identifier" && abortControllerInScope(value.name)) ||
      isAbortControllerCurrent(value)
    );
  }

  function isKnownAbortSignalStatusRead(node) {
    const value = unwrapCasts(node);
    if (value?.type !== "MemberExpression" || memberName(value) !== "aborted") {
      return false;
    }
    const signal = unwrapCasts(value.object);
    if (
      signal?.type !== "MemberExpression" ||
      memberName(signal) !== "signal"
    ) {
      return false;
    }
    return isKnownAbortController(signal.object);
  }

  function isKnownAbortCall(callee) {
    const value = unwrapCasts(callee);
    return (
      value?.type === "MemberExpression" &&
      memberName(value) === "abort" &&
      isKnownAbortController(value.object)
    );
  }

  function enter(node) {
    functionStack.push({
      node,
      paramNames: paramNames(node.params),
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
    });
  }

  function exit() {
    const frame = functionStack.pop();
    if (!frame) return;
    const parent = functionStack[functionStack.length - 1] ?? null;
    // A request-identity guard is component-wide: one built in a nested helper bubbles
    // up, and one on an ancestor (e.g. useRef(new AbortController())) is inherited down,
    // so the transition is exempt wherever the controller is actually constructed.
    if (frame.requestGuard && parent) parent.requestGuard = true;
    if (!frame.requestGuard) {
      frame.requestGuard = functionStack.some(
        (ancestor) => ancestor.requestGuard,
      );
    }
    // A transition only proves with setters it owns or that its immediate component
    // parent owns; setters reached from a deeper ancestor (a nested closure) do not prove.
    frame.ownerSetters = parent
      ? new Set([...frame.setters, ...parent.setters])
      : frame.setters;
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
    if (onFrameExit) onFrameExit(frame);
  }

  return {
    visitors: {
      ImportDeclaration(node) {
        if (node.source?.value !== "react") return;
        for (const specifier of node.specifiers ?? []) {
          const localName = specifier.local?.name;
          if (!localName) continue;
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            reactObjectLocals.add(localName);
            continue;
          }
          const hookLocals = reactHookLocals.get(importedName(specifier));
          if (hookLocals) hookLocals.add(localName);
        }
      },
      VariableDeclarator(node) {
        const frame = top();
        if (!frame) return;
        const init = unwrapCasts(node.init);
        if (node.id?.type === "Identifier" && isNewAbortController(init)) {
          frame.abortControllers.add(node.id.name);
        }
        if (node.id?.type === "Identifier" && isAbortControllerRefInit(init)) {
          frame.abortControllerRefs.add(node.id.name);
        }
        if (
          init?.type === "CallExpression" &&
          isReactHookCallee(init.callee, "useState") &&
          node.id?.type === "ArrayPattern"
        ) {
          const cell = node.id.elements?.[0];
          const setter = node.id.elements?.[1];
          if (setter?.type === "Identifier") {
            frame.setters.add(setter.name);
            if (cell?.type === "Identifier") {
              frame.cellOf.set(setter.name, cell.name);
            }
          }
        }
        if (
          init &&
          unwrapCasts(init)?.type === "AwaitExpression" &&
          node.id?.type === "Identifier"
        ) {
          frame.awaitedNames.add(node.id.name);
          frame.awaitedSourceInits.set(node.id.name, init);
        }
      },
      AwaitExpression() {
        const frame = top();
        if (frame) frame.isTransition = true;
      },
      TryStatement() {
        const frame = top();
        if (frame) frame.isTransition = true;
      },
      MemberExpression(node) {
        const frame = top();
        if (frame && isKnownAbortSignalStatusRead(node)) {
          frame.requestGuard = true;
        }
      },
      JSXAttribute(node) {
        const frame = top();
        if (!frame) return;
        const name = node.name?.name;
        if (name !== "value" && name !== "checked") return;
        const cell =
          node.value?.type === "JSXExpressionContainer"
            ? identifierName(node.value.expression)
            : "";
        if (cell && cellInScope(cell)) frame.controlledCells.add(cell);
      },
      CatchClause(node) {
        catchParams.push(
          node.param?.type === "Identifier" ? node.param.name : null,
        );
      },
      "CatchClause:exit"() {
        catchParams.pop();
      },
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        const frame = top();
        if (!frame) return;
        if (isKnownAbortCall(node.callee)) frame.requestGuard = true;
        const calleeName =
          node.callee?.type === "Identifier" ? node.callee.name : null;
        if (!calleeName || !setterInScope(calleeName)) return;
        frame.called.add(calleeName);
        if (catchParams.length > 0) frame.catchSetters.add(calleeName);
        const arg = node.arguments?.[0];
        if (!arg) return;
        const cell = frame.cellOf.get(calleeName) ?? cellFor(calleeName);
        if (cell && !frame.cellOf.has(calleeName)) {
          frame.cellOf.set(calleeName, cell);
        }
        if (cell && isParamDerivedValue(arg, frame.paramNames)) {
          frame.eventEditedCells.add(cell);
        }
        const sourceWrite = sourceMemberWrite(arg, frame.awaitedNames);
        if (sourceWrite && cell) {
          frame.sourceMemberWrites.push({
            ...sourceWrite,
            setter: calleeName,
            cell,
          });
        }
        const valueClass = classifyWriteValue(arg, {
          awaitedNames: frame.awaitedNames,
          catchParams,
        });
        if (valueClass === "updater") frame.updaterSetters.add(calleeName);
        if (!valueClass || valueClass === "updater" || valueClass === "other") {
          return;
        }
        const classes = frame.writes.get(calleeName) ?? new Set();
        classes.add(valueClass);
        frame.writes.set(calleeName, classes);
      },
    },
  };
}

function payloadCellFromSourceMember(frame, owned, blocked) {
  return (
    frame.sourceMemberWrites.find(
      (write) => owned.has(write.setter) && !blocked.has(write.setter),
    )?.setter ?? null
  );
}

// Derive resource-lifecycle roles from a frame's behavior-classified writes. The
// proof is one boolean cell toggled true->false, a distinct error cell written
// inside catch, and a distinct payload cell assigned the awaited value or an
// awaited source member. requestGuard is reported separately so consumers decide
// whether to downgrade.
export function lifecycleProof(frame) {
  const owned = frame.ownerSetters ?? frame.setters;
  if ([...frame.updaterSetters].some((setter) => owned.has(setter))) {
    return {
      boolCell: null,
      errorCell: null,
      payloadCell: null,
      proven: false,
    };
  }
  const entries = [...frame.writes.entries()].filter(([setter]) =>
    owned.has(setter),
  );
  const boolCell =
    entries.find(
      ([, classes]) => classes.has("trueConst") && classes.has("falseConst"),
    )?.[0] ?? null;
  const errorCell = boolCell
    ? ([...frame.catchSetters].find(
        (name) => name !== boolCell && owned.has(name),
      ) ?? null)
    : null;
  const blocked = new Set([boolCell, errorCell].filter(Boolean));
  const directPayloadCell = errorCell
    ? (entries.find(
        ([name, classes]) => !blocked.has(name) && classes.has("awaited"),
      )?.[0] ?? null)
    : null;
  const payloadCell =
    directPayloadCell ??
    (errorCell ? payloadCellFromSourceMember(frame, owned, blocked) : null);
  return { boolCell, errorCell, payloadCell, proven: Boolean(payloadCell) };
}

// Source-member shard: at least `threshold` distinct state cells each receive a
// distinct member of the SAME freshly awaited source object in one transition,
// excluding controlled-input draft cells that are independently edited from events.
// This is behavioral fan-out only; owned-entity proof is added by the rule layer.
export function sourceShardProof(frame, { threshold = 2 } = {}) {
  const editableCells = new Set(
    [...frame.eventEditedCells].filter((cell) =>
      frame.controlledCells.has(cell),
    ),
  );
  for (const transition of frame.sourceMemberTransitions) {
    if (!transition.transition) continue;
    const byCell = new Map();
    for (const entry of transition.entries) {
      if (editableCells.has(entry.cell)) continue;
      byCell.set(entry.cell, entry);
    }
    const entries = [...byCell.values()];
    const properties = new Set(entries.map((entry) => entry.property));
    if (entries.length >= threshold && properties.size >= threshold) {
      return {
        ...transition,
        entries,
        editableCells: [...editableCells].sort((left, right) =>
          left.localeCompare(right),
        ),
        proven: true,
      };
    }
  }
  return {
    entries: [],
    editableCells: [...editableCells].sort((left, right) =>
      left.localeCompare(right),
    ),
    proven: false,
  };
}

// Serializable, sanitizable view of a frame's state graph for fact payloads.
export function frameStatePayload(frame) {
  const cells = {};
  for (const [setter, classes] of frame.writes) {
    cells[setter] = {
      cell: frame.cellOf.get(setter) ?? null,
      writes: [...classes].sort((left, right) => left.localeCompare(right)),
    };
  }
  return {
    transition: Boolean(frame.isTransition),
    requestGuard: frame.requestGuard,
    setterCount: frame.called.size,
    cells,
  };
}
