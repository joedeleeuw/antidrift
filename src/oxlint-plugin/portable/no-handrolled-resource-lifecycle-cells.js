import { findDescendant, isIdentifier } from "./ast.js";
import { mergeVisitors } from "../shared/merge-visitors.js";
import {
  isRuleFile,
  ruleFilename,
  scopeProperties,
} from "../shared/rule-scope.js";
import {
  HOOK_NAME,
  calleeName,
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  isTestFile,
  nearestFunction,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);
const SIGNAL_NAMES = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const POLLED_EVENT_STATE = new Set([
  "readyState",
  "exitCode",
  "connected",
  "closed",
]);
const NON_EVENT_TARGET_RECEIVER = /(?:^document|^win|popup|window)$/iu;
const SHADOW_STATE_MIRROR_MESSAGE =
  "This state cell copies a prop or hook result and is only re-synced from an effect, so it renders one frame stale. Derive the value during render, or key the component to reset it.";

function isInsideSignalHandler(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (
      cur.type === "CallExpression" &&
      cur.callee?.type === "MemberExpression" &&
      !cur.callee.computed &&
      isIdentifier(cur.callee.object, "process") &&
      (isIdentifier(cur.callee.property, "on") ||
        isIdentifier(cur.callee.property, "once")) &&
      cur.arguments[0]?.type === "Literal" &&
      SIGNAL_NAMES.has(cur.arguments[0].value)
    ) {
      return true;
    }
  }
  return false;
}

function collectDescendants(root, predicate) {
  const matches = [];
  findDescendant(
    root,
    (candidate) => {
      if (predicate(candidate)) matches.push(candidate);
      return false;
    },
    (candidate) => candidate === root || !isFunctionLike(candidate)
  );
  return matches;
}

function booleanMemberNames(typeNode) {
  const names = new Set();
  for (const member of typeNode?.members ?? []) {
    if (
      member.type === "TSPropertySignature" &&
      member.key?.type === "Identifier" &&
      member.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword"
    ) {
      names.add(member.key.name);
    }
  }
  return names;
}

function isCrossTransitionReturn(statement, booleanProps) {
  if (
    statement.type !== "ReturnStatement" ||
    statement.argument?.type !== "ObjectExpression"
  ) {
    return false;
  }
  const phaseValues = new Set(
    statement.argument.properties
      .filter(
        (prop) =>
          prop.type === "Property" &&
          booleanProps.has(prop.key?.name) &&
          typeof prop.value?.value === "boolean"
      )
      .map((prop) => prop.value.value)
  );
  return phaseValues.size === 2;
}

function checkReducerMutuallyExclusiveFlags(fnNode, context) {
  const booleanProps = booleanMemberNames(
    fnNode.params?.[0]?.typeAnnotation?.typeAnnotation
  );
  if (booleanProps.size < 3) return;
  const transitions = collectDescendants(fnNode.body, (candidate) =>
    isCrossTransitionReturn(candidate, booleanProps)
  );
  if (transitions.length >= 2) {
    context.report({
      node: fnNode,
      message:
        "Reducer co-mutates >= 3 boolean activity flags as mutually exclusive phases; replace with a single discriminated phase union.",
    });
  }
}

function isMirrorSource(expression, owner, sourceCode) {
  const root =
    expression?.type === "MemberExpression"
      ? unwrapExpression(expression.object)
      : expression;
  const definition =
    root?.type === "Identifier"
      ? findVariable(sourceCode, root)?.defs?.[0]
      : null;
  if (definition?.type === "Parameter") return definition.node === owner;
  return (
    definition?.type === "Variable" &&
    HOOK_NAME.test(calleeName(unwrapExpression(definition.node.init)))
  );
}

function isEffectResync(reference, sourceText, sourceCode) {
  const call = reference.identifier.parent;
  if (call?.type !== "CallExpression" || call.callee !== reference.identifier) {
    return null;
  }
  const effect = nearestFunction(call)?.parent;
  if (
    effect?.type !== "CallExpression" ||
    !EFFECT_HOOKS.has(calleeName(effect)) ||
    nearestFunction(call) !== unwrapExpression(effect.arguments[0])
  ) {
    return null;
  }
  return call.arguments[0]
    ? sourceCode.getText(call.arguments[0]) === sourceText
    : false;
}

function checkShadowStateMirror(declarator, owner, context) {
  const sourceCode = context.sourceCode;
  const initial = unwrapExpression(
    unwrapExpression(declarator.init).arguments?.[0]
  );
  const setter = declarator.id.elements[1];
  if (!isMirrorSource(initial, owner, sourceCode)) return;
  const sourceText = sourceCode.getText(initial);
  const resyncs = (findVariable(sourceCode, setter)?.references ?? [])
    .filter((reference) => reference.identifier !== setter)
    .map((reference) => isEffectResync(reference, sourceText, sourceCode));
  if (
    resyncs.length > 0 &&
    resyncs.every((resync) => resync !== null) &&
    resyncs.includes(true)
  ) {
    context.report({ node: declarator, message: SHADOW_STATE_MIRROR_MESSAGE });
  }
}

function intervalCallback(node) {
  if (calleeName(node) !== "setInterval") return null;
  const callee = unwrapExpression(node.callee);
  const receiver = callee?.type === "MemberExpression" ? callee.object : null;
  if (
    receiver &&
    !/^(?:globalThis|window|global|timers)$/u.test(receiver.name ?? "")
  ) {
    return null;
  }
  const callback = unwrapExpression(node.arguments[0]);
  return isFunctionLike(callback) ? callback : null;
}

function isPolledEventState(candidate, sourceCode) {
  return (
    candidate.type === "MemberExpression" &&
    POLLED_EVENT_STATE.has(staticPropertyName(candidate)) &&
    !NON_EVENT_TARGET_RECEIVER.test(sourceCode.getText(candidate.object))
  );
}

function processLifecycleVisitors(context) {
  if (isTestFile(ruleFilename(context))) return {};
  return {
    CallExpression(node) {
      const callee = node.callee;
      if (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        isIdentifier(callee.property, "enterWith")
      ) {
        context.report({
          node,
          message:
            "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient async context frame with no restore point; scope it with run(...) at the boundary instead.",
        });
        return;
      }
      if (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        isIdentifier(callee.object, "app") &&
        isIdentifier(callee.property, "exit") &&
        isInsideSignalHandler(node)
      ) {
        context.report({
          node,
          message:
            "Do not call app.exit() inside a process signal handler; run graceful shutdown hooks before terminating.",
        });
        return;
      }
      const callback = intervalCallback(node);
      if (!callback) return;
      if (
        callback.body.type === "BlockStatement" &&
        callback.body.body.length === 0
      ) {
        context.report({
          node,
          message:
            "Empty setInterval callback only holds the process open; await the owning server, child process, or stdin lifecycle instead of a wall-clock hold-open timer.",
        });
        return;
      }
      const polled = collectDescendants(callback.body, (candidate) =>
        isPolledEventState(candidate, context.sourceCode)
      )[0];
      if (polled) {
        context.report({
          node,
          message: `setInterval polls '.${staticPropertyName(polled)}' on an event target; await its lifecycle event (events.once, 'exit', 'close', 'open') instead of timer-polling state.`,
        });
      }
    },
  };
}

const HOOK_OR_COMPONENT_NAME = /^(?:use[A-Z0-9]|[A-Z])/u;

function enclosingUiFunction(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!isFunctionLike(cur)) continue;
    if (functionReturnsJsx(cur)) return cur;
    const name =
      cur.id?.name ??
      (cur.parent?.type === "VariableDeclarator" &&
      cur.parent.id?.type === "Identifier"
        ? cur.parent.id.name
        : null);
    if (name && HOOK_OR_COMPONENT_NAME.test(name)) return cur;
  }
  return null;
}

function isUseStateCall(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.type !== "CallExpression") return false;
  const callee = unwrapExpression(unwrapped.callee);
  return (
    (callee?.type === "Identifier" && callee.name === "useState") ||
    (callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "React" &&
      callee.property?.type === "Identifier" &&
      callee.property.name === "useState")
  );
}

const GUARD_IDENTIFIER =
  /^(?:AbortController|signal|aborted|cancelled|canceled|generation|epoch|version|requestId|disposed)$/iu;
const SNAPSHOT_MEMBER =
  /^(?:getSnapshot|subscribe|failure|error|status|state|snapshot)$/iu;

function isAbortOrGenerationGuardNode(node) {
  return (
    findDescendant(
      node,
      (candidate) =>
        candidate.type === "Identifier" && GUARD_IDENTIFIER.test(candidate.name)
    ) !== null
  );
}

const DUAL_CHANNEL_METHODS = new Set([
  "activate",
  "bind",
  "setOnError",
  "registerError",
]);

function storeHasSnapshotReadInScope(fnNode, storeName) {
  return (
    findDescendant(
      fnNode,
      (candidate) =>
        candidate.type === "MemberExpression" &&
        !candidate.computed &&
        candidate.object?.type === "Identifier" &&
        candidate.object.name === storeName &&
        SNAPSHOT_MEMBER.test(staticPropertyName(candidate))
    ) !== null
  );
}

class ResourceLifecycleAnalysis {
  constructor(context) {
    this.context = context;
    this.filename = (this.context.filename ?? "").replaceAll("\\", "/");
    this.sourceCode = this.context.sourceCode;
    this.setterVariables = new Set();
    this.fnStack = [];
  }
  enterFunction = (node) => {
    checkReducerMutuallyExclusiveFlags(node, this.context);
    this.fnStack.push({
      node,
      isAsync: Boolean(node.async),
      hasAwait: false,
      hasCatch: false,
      booleanFlagsDeclared: new Set(),
      booleanSetterToggledTrue: new Set(),
      booleanSetterToggledFalse: new Set(),
      errorSetterCalledInCatch: new Set(),
      resourceSetterCalled: new Set(),
      childCrossFlagTransitions: false,
      childTrueSetters: new Set(),
      childFlagGroups: [],
    });
  };

  exitFunction = () => {
    const frame = this.fnStack.pop();
    if (!frame) return;
    const parentFrame = this.fnStack.at(-1);
    const hasCrossFlag = [...frame.booleanSetterToggledTrue].some(
      (trueSetter) =>
        [...frame.booleanSetterToggledFalse].some(
          (falseSetter) => falseSetter !== trueSetter
        )
    );
    if (parentFrame) {
      for (const trueSetter of frame.booleanSetterToggledTrue) {
        parentFrame.childTrueSetters.add(trueSetter);
      }
      if (hasCrossFlag) {
        parentFrame.childCrossFlagTransitions = true;
        parentFrame.childFlagGroups.push(
          new Set([
            ...frame.booleanSetterToggledTrue,
            ...frame.booleanSetterToggledFalse,
          ])
        );
      }
    }
    this.reportPhaseFlags(frame);
    if (!frame.isAsync && !frame.hasAwait) return;
    if (isAbortOrGenerationGuardNode(frame.node)) return;
    const toggledBool = [...frame.booleanSetterToggledTrue].some(
      (bindingSymbol) => frame.booleanSetterToggledFalse.has(bindingSymbol)
    );
    if (
      toggledBool &&
      frame.errorSetterCalledInCatch.size > 0 &&
      frame.resourceSetterCalled.size > 0
    ) {
      this.context.report({
        node: frame.node,
        message:
          "This async transition hand-rolls a resource lifecycle: a constant lifecycle cell is toggled around the request while sibling cells receive the resource value and caught error. Model one resource/reducer value instead of coupled setters.",
      });
    }
  };

  reportPhaseFlags = (frame) => {
    if (frame.booleanFlagsDeclared.size < 3) return;
    if (frame.childCrossFlagTransitions && frame.childTrueSetters.size >= 2) {
      this.context.report({
        node: frame.node,
        message:
          "Hook defines >= 3 boolean activity flags co-mutated across transition handlers as mutually exclusive phases; model a single discriminated phase union.",
      });
      return;
    }
    const groupedWrite = frame.childFlagGroups.some(
      (group) =>
        [...group].filter((setter) => frame.booleanFlagsDeclared.has(setter))
          .length >= 3
    );
    if (groupedWrite) {
      this.context.report({
        node: frame.node,
        message:
          "Hook or component sets >= 3 boolean lifecycle flags together as mutually exclusive phases; replace them with a single discriminated phase state.",
      });
    }
  };

  insideCatch = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === "CatchClause") return true;
      if (isFunctionLike(current)) return false;
    }
    return false;
  };

  checkDualChannelCall = (node) => {
    const outerFn = this.fnStack[0]?.node;
    if (
      !outerFn ||
      node.callee?.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.object?.type !== "Identifier" ||
      node.callee.property?.type !== "Identifier" ||
      !DUAL_CHANNEL_METHODS.has(node.callee.property.name) ||
      !storeHasSnapshotReadInScope(outerFn, node.callee.object.name)
    ) {
      return;
    }
    for (const arg of node.arguments) {
      if (arg.type !== "Identifier") continue;
      const bindingSymbol = findVariable(this.sourceCode, arg);
      if (bindingSymbol && this.setterVariables.has(bindingSymbol)) {
        this.context.report({
          node: arg,
          message: `React state setter '${arg.name}' is passed into store method '${node.callee.property.name}', creating dual-channel state ownership; read the fact from the store snapshot instead.`,
        });
      }
    }
  };

  checkProgramDeclarator = (kind, declarator) => {
    if (declarator.id?.type !== "Identifier") return;
    const init = unwrapExpression(declarator.init);
    if (
      init?.type === "CallExpression" &&
      init.callee?.type === "Identifier" &&
      init.callee.name === "makeMutable"
    ) {
      const def = findVariable(this.sourceCode, init.callee)?.defs?.[0];
      if (
        def?.node?.type === "TSDeclareFunction" ||
        (def?.type === "ImportBinding" &&
          def.parent?.source?.value === "react-native-reanimated")
      ) {
        this.context.report({
          node: declarator,
          message: `Module-scope 'makeMutable' binding '${declarator.id.name}' shares mutable UI state across component instances; own the shared value inside a hook or context.`,
        });
      }
      return;
    }
    if (kind !== "let") return;
    const bindingSymbol = findVariable(this.sourceCode, declarator.id);
    if (!bindingSymbol) return;
    const mutatedInUi = bindingSymbol.references.some((ref) => {
      const parent = ref.identifier.parent;
      return (
        ref.isWrite() &&
        Boolean(enclosingUiFunction(ref.identifier)) &&
        parent?.type === "AssignmentExpression" &&
        parent.operator === "=" &&
        parent.left === ref.identifier
      );
    });
    const readInUi = bindingSymbol.references.some(
      (ref) => ref.isRead() && Boolean(enclosingUiFunction(ref.identifier))
    );
    const isBoolInit =
      declarator.init?.type === "Literal" &&
      typeof declarator.init.value === "boolean";
    if (mutatedInUi && (readInUi || isBoolInit)) {
      this.context.report({
        node: declarator,
        message: `Module-scope 'let ${declarator.id.name}' is mutated inside a React component or hook; move UI state into React state/context or a dedicated store.`,
      });
    }
  };

  onProgram = (programNode) => {
    if (isTestFile(this.filename)) return;
    const isTsx = this.filename.endsWith(".tsx");
    const moduleLets = [];
    for (const stmt of programNode.body) {
      const decl =
        stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const declarator of decl.declarations) {
        if (isTsx) this.checkProgramDeclarator(decl.kind, declarator);
        if (decl.kind === "let" && declarator.id?.type === "Identifier") {
          moduleLets.push(declarator);
        }
      }
    }
    if (!isTsx && moduleLets.length >= 4) {
      const names = moduleLets
        .slice(0, 4)
        .map((declarator) => declarator.id.name)
        .join(", ");
      this.context.report({
        node: moduleLets[0],
        message: `Module scatters ${moduleLets.length} mutable 'let' state cells (${names}) at file scope; consolidate state into a single store object or state machine.`,
      });
    }
  };

  onVariableDeclarator = (node) => {
    if (
      node.id?.type === "ArrayPattern" &&
      node.id.elements.length >= 2 &&
      node.id.elements[1]?.type === "Identifier" &&
      isUseStateCall(node.init)
    ) {
      const owner = enclosingUiFunction(node);
      if (owner) checkShadowStateMirror(node, owner, this.context);
      const bindingSymbol = findVariable(this.sourceCode, node.id.elements[1]);
      if (bindingSymbol) {
        this.setterVariables.add(bindingSymbol);
        const initArg = unwrapExpression(node.init)?.arguments?.[0];
        if (initArg?.type === "Literal" && typeof initArg.value === "boolean") {
          this.fnStack.at(-1)?.booleanFlagsDeclared.add(bindingSymbol);
        }
      }
    }
  };

  onAwaitExpression = () => {
    const frame = this.fnStack.at(-1);
    if (frame) frame.hasAwait = true;
  };

  onCatchClause = () => {
    const frame = this.fnStack.at(-1);
    if (frame) frame.hasCatch = true;
  };

  hasPreviousValueGuard = (node) => {
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (isFunctionLike(current)) return false;
      if (current.type === "IfStatement" && current.consequent === child) {
        const test = unwrapExpression(current.test);
        if (
          test?.type === "BinaryExpression" &&
          ["!==", "!=", "<", ">", "<=", ">="].includes(test.operator)
        ) {
          return true;
        }
        if (
          test?.type === "CallExpression" &&
          test.callee?.type === "MemberExpression" &&
          staticPropertyName(test.callee) === "is" &&
          test.callee.object?.type === "Identifier" &&
          test.callee.object.name === "Object"
        ) {
          return true;
        }
      }
      child = current;
    }
    return false;
  };

  onCallExpression = (node) => {
    this.checkDualChannelCall(node);
    const frame = this.fnStack.at(-1);
    if (!frame || node.callee?.type !== "Identifier") return;
    const bindingSymbol = findVariable(this.sourceCode, node.callee);
    if (!bindingSymbol || !this.setterVariables.has(bindingSymbol)) return;
    if (
      this.fnStack.length === 1 &&
      enclosingUiFunction(node) === frame.node &&
      !this.hasPreviousValueGuard(node)
    ) {
      this.context.report({
        node,
        message: `React state setter '${node.callee.name}' is called synchronously during render; derive the value during render instead of latching state.`,
      });
    }
    const arg = unwrapExpression(node.arguments[0]);
    if (arg?.type === "Literal" && typeof arg.value === "boolean") {
      if (arg.value) {
        frame.booleanSetterToggledTrue.add(bindingSymbol);
      } else {
        frame.booleanSetterToggledFalse.add(bindingSymbol);
      }
      return;
    }
    if (this.insideCatch(node)) {
      frame.errorSetterCalledInCatch.add(bindingSymbol);
      return;
    }
    if (arg && !(arg.type === "Literal" && arg.value === null)) {
      frame.resourceSetterCalled.add(bindingSymbol);
    }
  };

  listeners() {
    return {
      Program: this.onProgram,
      FunctionDeclaration: this.enterFunction,
      "FunctionDeclaration:exit": this.exitFunction,
      FunctionExpression: this.enterFunction,
      "FunctionExpression:exit": this.exitFunction,
      ArrowFunctionExpression: this.enterFunction,
      "ArrowFunctionExpression:exit": this.exitFunction,
      VariableDeclarator: this.onVariableDeclarator,
      AwaitExpression: this.onAwaitExpression,
      CatchClause: this.onCatchClause,
      CallExpression: this.onCallExpression,
    };
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled resource-lifecycle state machines, multi-boolean activity phase flags, shadow state mirrors, dual-channel store setters, module-scope mutable UI state, and timer-based process lifecycle hacks.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return mergeVisitors(
      new ResourceLifecycleAnalysis(context).listeners(),
      processLifecycleVisitors(context)
    );
  },
};
