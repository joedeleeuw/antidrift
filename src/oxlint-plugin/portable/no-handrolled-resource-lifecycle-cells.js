import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  findVariable,
  functionReturnsJsx,
  isFunctionLike,
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

function isAbortOrGenerationGuardNode(node) {
  let found = false;
  function visit(current) {
    if (found || !current || typeof current !== "object") return;
    if (
      current.type === "Identifier" &&
      /^(?:AbortController|signal|aborted|cancelled|canceled|generation|epoch|version|requestId|disposed)$/iu.test(
        current.name
      )
    ) {
      found = true;
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const nestedChild of child) visit(nestedChild);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  }
  visit(node);
  return found;
}

const DUAL_CHANNEL_METHODS = new Set([
  "activate",
  "bind",
  "setOnError",
  "registerError",
]);

function isReducerCrossTransitionReturn(stmt, boolProps) {
  if (
    stmt.type !== "ReturnStatement" ||
    stmt.argument?.type !== "ObjectExpression"
  ) {
    return false;
  }
  let hasTrue = false;
  let hasFalse = false;
  for (const prop of stmt.argument.properties) {
    if (
      prop.type === "Property" &&
      prop.key?.type === "Identifier" &&
      boolProps.has(prop.key.name) &&
      prop.value?.type === "Literal" &&
      typeof prop.value.value === "boolean"
    ) {
      if (prop.value.value) hasTrue = true;
      else hasFalse = true;
    }
  }
  return hasTrue && hasFalse;
}

function checkReducerMutuallyExclusiveFlags(fnNode, context) {
  const firstParam = fnNode.params?.[0];
  const typeNode = firstParam?.typeAnnotation?.typeAnnotation;
  if (typeNode?.type !== "TSTypeLiteral") return;
  const boolProps = new Set();
  for (const member of typeNode.members) {
    if (
      member.type === "TSPropertySignature" &&
      member.key?.type === "Identifier" &&
      member.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword"
    ) {
      boolProps.add(member.key.name);
    }
  }
  if (boolProps.size < 3) return;
  let crossTransitionCount = 0;
  function visit(cur) {
    if (!cur || typeof cur !== "object") return;
    if (cur !== fnNode && isFunctionLike(cur)) return;
    if (isReducerCrossTransitionReturn(cur, boolProps)) {
      crossTransitionCount += 1;
    }
    for (const [key, child] of Object.entries(cur)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const nestedChild of child) visit(nestedChild);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  }
  visit(fnNode.body);
  if (crossTransitionCount >= 2) {
    context.report({
      node: fnNode,
      message:
        "Reducer co-mutates >= 3 boolean activity flags as mutually exclusive phases; replace with a single discriminated phase union.",
    });
  }
}

function storeHasSnapshotReadInScope(fnNode, storeName) {
  let found = false;
  function visit(cur) {
    if (found || !cur || typeof cur !== "object") return;
    if (
      cur.type === "MemberExpression" &&
      !cur.computed &&
      cur.object?.type === "Identifier" &&
      cur.object.name === storeName &&
      cur.property?.type === "Identifier" &&
      /^(?:getSnapshot|subscribe|failure|error|status|state|snapshot)$/iu.test(
        cur.property.name
      )
    ) {
      found = true;
      return;
    }
    for (const [key, child] of Object.entries(cur)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const nestedChild of child) visit(nestedChild);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  }
  visit(fnNode);
  return found;
}

class ResourceLifecycleAnalysis {
  constructor(context) {
    this.context = context;
    this.filename = (
      this.context.filename ??
      this.context.getFilename?.() ??
      ""
    ).replaceAll("\\", "/");
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
      }
    }
    if (
      frame.booleanFlagsDeclared.size >= 3 &&
      frame.childCrossFlagTransitions &&
      frame.childTrueSetters.size >= 2
    ) {
      this.context.report({
        node: frame.node,
        message:
          "Hook defines >= 3 boolean activity flags co-mutated across transition handlers as mutually exclusive phases; model a single discriminated phase union.",
      });
    }
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

  onProgram = (programNode) => {
    if (!this.filename.endsWith(".tsx")) return;
    for (const stmt of programNode.body) {
      const decl =
        stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
      if (decl?.type !== "VariableDeclaration") continue;
      for (const declarator of decl.declarations) {
        if (declarator.id?.type !== "Identifier") continue;
        const init = unwrapExpression(declarator.init);
        if (
          init?.type === "CallExpression" &&
          init.callee?.type === "Identifier" &&
          init.callee.name === "makeMutable"
        ) {
          this.context.report({
            node: declarator,
            message: `Module-scope 'makeMutable' binding '${declarator.id.name}' shares mutable UI state across component instances; own the shared value inside a hook or context.`,
          });
          continue;
        }
        if (decl.kind !== "let") continue;
        const bindingSymbol = findVariable(this.sourceCode, declarator.id);
        if (!bindingSymbol) continue;
        const mutatedInUi = bindingSymbol.references.some(
          (ref) => ref.isWrite() && Boolean(enclosingUiFunction(ref.identifier))
        );
        if (mutatedInUi) {
          this.context.report({
            node: declarator,
            message: `Module-scope 'let ${declarator.id.name}' is mutated inside a React component or hook; move UI state into React state/context or a dedicated store.`,
          });
        }
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
        "Disallow hand-rolled resource-lifecycle state machines: an async transition that toggles a boolean lifecycle cell, resets and assigns an error cell, and assigns an awaited resource cell.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          threshold: { type: "number" },
          shardThreshold: { type: "number" },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new ResourceLifecycleAnalysis(context).listeners();
  },
};
