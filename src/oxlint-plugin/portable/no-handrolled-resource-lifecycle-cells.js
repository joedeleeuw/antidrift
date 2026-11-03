import { findDescendant } from "./ast.js";
import {
  checkReducerMutuallyExclusiveFlags,
  checkShadowStateMirror,
  processLifecycleVisitors,
} from "./lifecycle-process-checks.js";
import { mergeVisitors } from "../shared/merge-visitors.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
  isTestFile,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";

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
    if (!this.filename.endsWith(".tsx") || isTestFile(this.filename)) return;
    for (const stmt of programNode.body) {
      const decl =
        stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const declarator of decl.declarations) {
        this.checkProgramDeclarator(decl.kind, declarator);
      }
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

  onCallExpression = (node) => {
    this.checkDualChannelCall(node);
    const frame = this.fnStack.at(-1);
    if (!frame || node.callee?.type !== "Identifier") return;
    const bindingSymbol = findVariable(this.sourceCode, node.callee);
    if (!bindingSymbol || !this.setterVariables.has(bindingSymbol)) return;
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
