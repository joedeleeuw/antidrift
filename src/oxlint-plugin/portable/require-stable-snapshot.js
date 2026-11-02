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
const collectReturnArguments = (node, results) => {
  if (!node || typeof node !== "object") {
    return;
  }
  switch (node.type) {
    case "BlockStatement": {
      for (const statement of node.body) {
        collectReturnArguments(statement, results);
      }
      return;
    }
    case "IfStatement": {
      collectReturnArguments(node.consequent, results);
      collectReturnArguments(node.alternate, results);
      return;
    }
    case "SwitchStatement": {
      for (const switchCase of node.cases) {
        for (const statement of switchCase.consequent) {
          collectReturnArguments(statement, results);
        }
      }
      return;
    }
    case "TryStatement": {
      collectReturnArguments(node.block, results);
      if (node.handler) {
        collectReturnArguments(node.handler.body, results);
      }
      collectReturnArguments(node.finalizer, results);
      return;
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement": {
      collectReturnArguments(node.body, results);
      return;
    }
    case "ReturnStatement": {
      if (node.argument) {
        results.push(node.argument);
      }
      return;
    }
    default:
      return;
  }
};
const isFreshReturnedValue = (expr, fnScope, sourceCode) => {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return false;
  if (isFreshReferenceExpression(unwrapped)) return true;
  if (unwrapped.type === "Identifier" && fnScope) {
    const variable = findVariable(sourceCode, unwrapped);
    if (variable && variable.scope === fnScope) {
      const def = variable.defs?.[0];
      if (def?.node?.type === "VariableDeclarator") {
        return isFreshReferenceExpression(def.node.init);
      }
    }
  }
  return false;
};
const snapshotReturnsFreshReference = (fn, sourceCode) => {
  const fnScope = sourceCode?.getScope?.(fn);
  if (fn.body.type !== "BlockStatement") {
    return isFreshReturnedValue(fn.body, fnScope, sourceCode);
  }
  const returnArguments = [];
  collectReturnArguments(fn.body, returnArguments);
  return returnArguments.some((argument) =>
    isFreshReturnedValue(argument, fnScope, sourceCode)
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
  const variable = findVariable(sourceCode, expr.object);
  const init = unwrapExpression(variable?.defs?.[0]?.node?.init);
  if (init?.type !== "ObjectExpression") return null;
  for (const prop of init.properties) {
    if (
      prop.type === "Property" &&
      !prop.computed &&
      prop.key?.type === "Identifier" &&
      prop.key.name === expr.property.name
    ) {
      const value = unwrapExpression(prop.value);
      return isFunctionLike(value) ? value : null;
    }
  }
  return null;
};
const resolveSnapshotCallback = (arg, sourceCode) => {
  const expr = unwrapExpression(arg);
  if (!expr) return null;
  if (isFunctionLike(expr)) return expr;
  if (expr.type === "Identifier") {
    const variable = findVariable(sourceCode, expr);
    const defNode = variable?.defs?.[0]?.node;
    if (isFunctionLike(defNode)) return defNode;
    const init = unwrapExpression(defNode?.init);
    return isFunctionLike(init) ? init : null;
  }
  return resolveObjectMethodCallback(expr, sourceCode);
};
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

    const useSyncExternalStoreAliases = new Set();
    const reactNamespaces = new Set();
    const isUseSyncExternalStoreCallee = (callee) => {
      if (
        isIdentifier(callee) &&
        useSyncExternalStoreAliases.has(callee.name)
      ) {
        return true;
      }
      return (
        callee.type === "MemberExpression" &&
        callee.computed === false &&
        isIdentifier(callee.object) &&
        reactNamespaces.has(callee.object.name) &&
        isIdentifier(callee.property, HOOK_NAME)
      );
    };
    if (
      (() => {
        useSyncExternalStoreAliases.clear();
        reactNamespaces.clear();
      })() === false
    ) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        if (node.source?.value !== REACT_MODULE) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            reactNamespaces.add(specifier.local.name);
            continue;
          }
          if (
            specifier.type === "ImportSpecifier" &&
            getImportedName(specifier) === HOOK_NAME
          ) {
            useSyncExternalStoreAliases.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (!isUseSyncExternalStoreCallee(node.callee)) {
          return;
        }
        for (const index of SNAPSHOT_ARG_INDICES) {
          const cb = resolveSnapshotCallback(
            node.arguments[index],
            context.sourceCode
          );
          if (!cb) {
            continue;
          }
          if (snapshotReturnsFreshReference(cb, context.sourceCode)) {
            context.report({ node, messageId: "requireStableSnapshot" });
            return;
          }
        }
      },
    };
  },
};
