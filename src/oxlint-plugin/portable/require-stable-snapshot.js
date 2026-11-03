import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { findVariable, isFunctionLike } from "../shared/scope.js";
import { getImportedName, isIdentifier, unwrapExpression } from "./ast.js";

const REACT_MODULE = "react";
const HOOK_NAME = "useSyncExternalStore";
const SNAPSHOT_ARG_INDICES = [1, 2];
const FRESH_REFERENCE_MEMBER_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "toSpliced",
]);
const isFreshReferenceCall = (node) => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.property)
  ) {
    return false;
  }
  if (isIdentifier(callee.object)) {
    const staticName = `${callee.object.name}.${callee.property.name}`;
    if (staticName === "Array.from") {
      return true;
    }
    if (staticName === "Object.assign") {
      return isFreshReferenceExpression(node.arguments[0]);
    }
  }
  return FRESH_REFERENCE_MEMBER_METHODS.has(callee.property.name);
};
const isFreshReferenceExpression = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (
    unwrapped.type === "ObjectExpression" ||
    unwrapped.type === "ArrayExpression"
  ) {
    return true;
  }
  return isFreshReferenceCall(unwrapped);
};
const collectReturnArguments = (node, returnArguments) => {
  if (!node || typeof node !== "object") {
    return;
  }
  switch (node.type) {
    case "BlockStatement":
      for (const statement of node.body) {
        collectReturnArguments(statement, returnArguments);
      }
      return;
    case "IfStatement":
      collectReturnArguments(node.consequent, returnArguments);
      collectReturnArguments(node.alternate, returnArguments);
      return;
    case "SwitchStatement":
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) {
          collectReturnArguments(statement, returnArguments);
        }
      }
      return;
    case "TryStatement":
      collectReturnArguments(node.block, returnArguments);
      if (node.handler) {
        collectReturnArguments(node.handler.body, returnArguments);
      }
      collectReturnArguments(node.finalizer, returnArguments);
      return;
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      collectReturnArguments(node.body, returnArguments);
      return;
    case "ReturnStatement":
      if (node.argument) {
        returnArguments.push(node.argument);
      }
      return;
    default:
      return;
  }
};
const isFreshReturnExpression = (expr, fnScope, sourceCode) => {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return false;
  if (isFreshReferenceExpression(unwrapped)) return true;
  if (unwrapped.type === "Identifier" && fnScope) {
    const bindingSymbol = findVariable(sourceCode, unwrapped);
    if (bindingSymbol && bindingSymbol.scope === fnScope) {
      const def = bindingSymbol.defs?.[0];
      if (def?.node?.type === "VariableDeclarator") {
        return isFreshReferenceExpression(def.node.init);
      }
    }
  }
  return false;
};
const snapshotReturnsFreshReference = (snapshotCallback, sourceCode) => {
  const fnScope = sourceCode?.getScope?.(snapshotCallback);
  if (snapshotCallback.body.type !== "BlockStatement") {
    return isFreshReturnExpression(snapshotCallback.body, fnScope, sourceCode);
  }
  const returnArguments = [];
  collectReturnArguments(snapshotCallback.body, returnArguments);
  return returnArguments.some((argument) =>
    isFreshReturnExpression(argument, fnScope, sourceCode)
  );
};
const resolveObjectMethodCallback = (expr, sourceCode) => {
  if (
    expr.type !== "MemberExpression" ||
    expr.computed ||
    expr.object?.type !== "Identifier" ||
    expr.property?.type !== "Identifier"
  ) {
    return null;
  }
  const bindingSymbol = findVariable(sourceCode, expr.object);
  const init = unwrapExpression(bindingSymbol?.defs?.[0]?.node?.init);
  if (init?.type !== "ObjectExpression") return null;
  for (const prop of init.properties) {
    if (
      prop.type === "Property" &&
      !prop.computed &&
      prop.key?.type === "Identifier" &&
      prop.key.name === expr.property.name
    ) {
      const propertyExpression = unwrapExpression(prop.value);
      return isFunctionLike(propertyExpression) ? propertyExpression : null;
    }
  }
  return null;
};
const resolveSnapshotCallback = (arg, sourceCode) => {
  const expr = unwrapExpression(arg);
  if (!expr) return null;
  if (isFunctionLike(expr)) return expr;
  if (expr.type === "Identifier") {
    const bindingSymbol = findVariable(sourceCode, expr);
    const defNode = bindingSymbol?.defs?.[0]?.node;
    if (isFunctionLike(defNode)) return defNode;
    const init = unwrapExpression(defNode?.init);
    return isFunctionLike(init) ? init : null;
  }
  return resolveObjectMethodCallback(expr, sourceCode);
};
class SnapshotAnalysis {
  constructor(context) {
    this.context = context;
    this.useSyncExternalStoreAliases = new Set();
    this.reactNamespaces = new Set();
  }
  isUseSyncExternalStoreCallee = (callee) => {
    if (
      isIdentifier(callee) &&
      this.useSyncExternalStoreAliases.has(callee.name)
    ) {
      return true;
    }
    return (
      callee.type === "MemberExpression" &&
      callee.computed === false &&
      isIdentifier(callee.object) &&
      this.reactNamespaces.has(callee.object.name) &&
      isIdentifier(callee.property, HOOK_NAME)
    );
  };

  onImportDeclaration = (node) => {
    if (node.source?.value !== REACT_MODULE) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportDefaultSpecifier" ||
        specifier.type === "ImportNamespaceSpecifier"
      ) {
        this.reactNamespaces.add(specifier.local.name);
        continue;
      }
      if (
        specifier.type === "ImportSpecifier" &&
        getImportedName(specifier) === HOOK_NAME
      ) {
        this.useSyncExternalStoreAliases.add(specifier.local.name);
      }
    }
  };

  onCallExpression = (node) => {
    if (!this.isUseSyncExternalStoreCallee(node.callee)) {
      return;
    }
    for (const index of SNAPSHOT_ARG_INDICES) {
      const snapshotCallback = resolveSnapshotCallback(
        node.arguments[index],
        this.context.sourceCode
      );
      if (!snapshotCallback) {
        continue;
      }
      if (
        snapshotReturnsFreshReference(snapshotCallback, this.context.sourceCode)
      ) {
        this.context.report({ node, messageId: "requireStableSnapshot" });
        return;
      }
    }
  };

  listeners() {
    return {
      ImportDeclaration: this.onImportDeclaration,
      CallExpression: this.onCallExpression,
    };
  }
}

export default {
  meta: {
    type: "problem",
    messages: {
      requireStableSnapshot:
        "getSnapshot/getServerSnapshot must return a cached reference, not a fresh object/array/derived collection each call. React compares results with Object.is, so an unstable snapshot trips 'The result of getSnapshot should be cached' and can loop into 'Maximum update depth exceeded'. Cache the snapshot in the store and return the same reference until the underlying data changes.",
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
    return new SnapshotAnalysis(context).listeners();
  },
};
