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

function isAbortCall(callee) {
  return callee?.type === "MemberExpression" && memberName(callee) === "abort";
}

function isAbortStatusRead(node) {
  return node?.type === "MemberExpression" && memberName(node) === "aborted";
}

export function createReactStateTracker({ onFrameExit } = {}) {
  const functionStack = [];
  const catchParams = [];
  const top = () => functionStack[functionStack.length - 1] ?? null;
  const setterInScope = (name) =>
    functionStack.some((frame) => frame.setters.has(name));
  // A setter's cell is declared in the owning component frame, but its writes happen
  // in a nested transition frame, so resolve the binding up the stack.
  const cellFor = (name) => {
    for (let depth = functionStack.length - 1; depth >= 0; depth -= 1) {
      const cell = functionStack[depth].cellOf.get(name);
      if (cell) return cell;
    }
    return null;
  };

  function enter(node) {
    functionStack.push({
      node,
      setters: new Set(),
      cellOf: new Map(),
      awaitedNames: new Set(),
      writes: new Map(),
      called: new Set(),
      isTransition: false,
      requestGuard: false,
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
    if (onFrameExit) onFrameExit(frame);
  }

  return {
    visitors: {
      VariableDeclarator(node) {
        const frame = top();
        if (!frame) return;
        const init = node.init;
        if (
          init?.type === "CallExpression" &&
          init.callee?.name === "useState" &&
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
        if (frame && isAbortStatusRead(node)) {
          frame.requestGuard = true;
        }
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
        if (isAbortCall(node.callee)) frame.requestGuard = true;
        const calleeName =
          node.callee?.type === "Identifier" ? node.callee.name : null;
        if (!calleeName || !setterInScope(calleeName)) return;
        frame.called.add(calleeName);
        const arg = node.arguments?.[0];
        if (!arg) return;
        const valueClass = classifyWriteValue(arg, {
          awaitedNames: frame.awaitedNames,
          catchParams,
        });
        if (!valueClass || valueClass === "updater" || valueClass === "other") {
          return;
        }
        const classes = frame.writes.get(calleeName) ?? new Set();
        classes.add(valueClass);
        frame.writes.set(calleeName, classes);
        if (!frame.cellOf.has(calleeName)) {
          const cell = cellFor(calleeName);
          if (cell) frame.cellOf.set(calleeName, cell);
        }
      },
    },
  };
}

// Derive resource-lifecycle roles from a frame's behavior-classified writes. The
// proof is the FULL hand-rolled machine: one boolean cell toggled true->false, a
// distinct error cell reset to a constant and assigned the caught error, and a
// distinct payload cell assigned the awaited value. requestGuard is reported
// separately so consumers decide whether to downgrade.
export function lifecycleProof(frame) {
  const owned = frame.ownerSetters ?? frame.setters;
  const entries = [...frame.writes.entries()].filter(([setter]) =>
    owned.has(setter),
  );
  const boolCell =
    entries.find(
      ([, classes]) => classes.has("trueConst") && classes.has("falseConst"),
    )?.[0] ?? null;
  const errorCell = boolCell
    ? (entries.find(
        ([name, classes]) =>
          name !== boolCell &&
          classes.has("nullConst") &&
          classes.has("caughtError"),
      )?.[0] ?? null)
    : null;
  const payloadCell = errorCell
    ? (entries.find(
        ([name, classes]) =>
          name !== boolCell && name !== errorCell && classes.has("awaited"),
      )?.[0] ?? null)
    : null;
  return { boolCell, errorCell, payloadCell, proven: Boolean(payloadCell) };
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
