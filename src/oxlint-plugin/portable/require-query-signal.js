import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./ast.js";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const GLOBAL_FETCH_HOSTS = new Set(["globalThis", "self", "window"]);
const isFunctionNode = (node) => FUNCTION_TYPES.has(node?.type);
const unwrapTS = (node) => {
  let current = node;
  while (
    current &&
    (current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSInstantiationExpression")
  ) {
    current = current.expression;
  }
  return current;
};
const nearestEnclosingFunction = (node) => {
  let current = node.parent;
  while (current) {
    if (isFunctionNode(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};
const skipWrapperAncestors = (node) => {
  let current = node;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }
  return current;
};
const isQueryFnProperty = (property) => {
  if (
    property?.type !== "Property" ||
    getPropertyName(property.key) !== "queryFn"
  ) {
    return false;
  }
  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }
  return objectExpression.properties.some(
    (sibling) =>
      sibling?.type === "Property" &&
      getPropertyName(sibling.key) === "queryKey"
  );
};
const isQueryFnFunction = (queryFunction) => {
  const property = skipWrapperAncestors(queryFunction.parent);
  return isQueryFnProperty(property);
};
const signalBindingName = (queryFunction) => {
  const firstParam = queryFunction.params?.at(0);
  if (firstParam?.type !== "ObjectPattern") {
    return null;
  }
  const signalProperty = firstParam.properties.find(
    (property) =>
      property?.type === "Property" &&
      getPropertyName(property.key) === "signal"
  );
  const expression = unwrapTS(signalProperty?.value);
  if (expression?.type === "Identifier") {
    return expression.name;
  }
  if (expression?.type === "AssignmentPattern") {
    const left = unwrapTS(expression.left);
    return left?.type === "Identifier" ? left.name : null;
  }
  return null;
};
const isFetchCallee = (callee, isGlobalReference) => {
  const unwrapped = unwrapTS(callee);
  if (isIdentifier(unwrapped, "fetch")) {
    return isGlobalReference(unwrapped, "fetch");
  }
  if (unwrapped?.type !== "MemberExpression" || unwrapped.computed !== false) {
    return false;
  }
  if (!isIdentifier(unwrapped.property, "fetch")) {
    return false;
  }
  const object = unwrapTS(unwrapped.object);
  return (
    isIdentifier(object) &&
    GLOBAL_FETCH_HOSTS.has(object.name) &&
    isGlobalReference(object, object.name)
  );
};
const rootIdentifier = (node) => {
  const unwrapped = unwrapTS(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return null;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object);
  }
  if (unwrapped.type === "CallExpression") {
    return rootIdentifier(unwrapped.callee);
  }
  return null;
};
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head"]);
const isEdenApiCallee = (callee, isEdenApiRoot) => {
  const unwrapped = unwrapTS(callee);
  if (unwrapped?.type !== "MemberExpression" || unwrapped.computed !== false) {
    return false;
  }
  const propertyName = getPropertyName(unwrapped.property);
  if (propertyName === null || !HTTP_VERBS.has(propertyName)) {
    return false;
  }
  return isEdenApiRoot(rootIdentifier(unwrapped.object));
};
const containsSignalIdentifier = (node, bindingName) => {
  const unwrapped = unwrapTS(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (isIdentifier(unwrapped, bindingName)) {
    return true;
  }
  if (unwrapped.type === "MemberExpression" && !unwrapped.computed) {
    return containsSignalIdentifier(unwrapped.object, bindingName);
  }
  if (unwrapped.type === "Property" && !unwrapped.computed) {
    return containsSignalIdentifier(unwrapped.value, bindingName);
  }
  return Object.entries(unwrapped).some(([key, expression]) => {
    if (key === "parent") {
      return false;
    }
    if (Array.isArray(expression)) {
      return expression.some((child) =>
        containsSignalIdentifier(child, bindingName)
      );
    }
    return containsSignalIdentifier(expression, bindingName);
  });
};
const objectPropertyExpression = (node, name) => {
  const object = unwrapTS(node);
  if (object?.type !== "ObjectExpression") {
    return null;
  }
  const property = object.properties.find(
    (candidate) =>
      candidate?.type === "Property" && getPropertyName(candidate.key) === name
  );
  return property?.value ?? null;
};
const callThreadsSignal = ({ bindingName, kind, node }) => {
  const call = isAstNode(node) && node.type === "CallExpression" ? node : null;
  const argumentsList =
    call !== null && Array.isArray(call.arguments) ? call.arguments : [];
  if (kind === "fetch") {
    return containsSignalIdentifier(
      objectPropertyExpression(argumentsList.at(1), "signal"),
      bindingName
    );
  }
  return argumentsList.some((argument) =>
    containsSignalIdentifier(
      objectPropertyExpression(
        objectPropertyExpression(argument, "fetch"),
        "signal"
      ),
      bindingName
    )
  );
};
class QuerySignalAnalysis {
  constructor(context) {
    this.context = context;
    this.networkCalls = [];
    this.queryFnReferences = [];
  }
  isEstreeIdentifier = (node) =>
    isIdentifier(node) && Array.isArray(node.range);

  resolveVariable = (identifier) => {
    let scope = this.context.sourceCode.getScope(identifier);
    while (scope !== null) {
      const bindingSymbol = scope.set.get(identifier.name);
      if (bindingSymbol !== undefined) {
        return bindingSymbol;
      }
      scope = scope.upper;
    }
    return null;
  };

  isGlobalReference = (node, name) => {
    if (!this.isEstreeIdentifier(node) || node.name !== name) {
      return false;
    }
    const bindingSymbol = this.resolveVariable(node);
    return bindingSymbol === null || bindingSymbol.defs.length === 0;
  };

  isEdenApiRoot = (node) => {
    if (!this.isEstreeIdentifier(node)) {
      return false;
    }
    const bindingSymbol = this.resolveVariable(node);
    if (bindingSymbol === null || bindingSymbol.defs.length !== 1) {
      return false;
    }
    const definition = bindingSymbol.defs.at(0);
    return (
      definition?.type === "ImportBinding" &&
      isAstNode(definition.node) &&
      getImportedName(definition.node) === "api" &&
      isAstNode(definition.parent) &&
      definition.parent.type === "ImportDeclaration" &&
      isStringLiteral(definition.parent.source) &&
      definition.parent.source.value === this.context.options[0]?.apiModule
    );
  };

  networkKind = (callee) => {
    if (isFetchCallee(callee, this.isGlobalReference)) {
      return "fetch";
    }
    return isEdenApiCallee(callee, this.isEdenApiRoot) ? "eden" : null;
  };

  hasReassignment = (bindingSymbol) =>
    bindingSymbol.references.some(
      (reference) => reference.init !== true && reference.isWrite?.() === true
    );

  resolveLocalQueryFunction = (identifier, visited = new Set()) => {
    const bindingSymbol = this.resolveVariable(identifier);
    if (
      bindingSymbol === null ||
      bindingSymbol.defs.length !== 1 ||
      visited.has(bindingSymbol) ||
      this.hasReassignment(bindingSymbol)
    ) {
      return null;
    }
    visited.add(bindingSymbol);
    const definition = bindingSymbol.defs.at(0);
    if (
      definition?.type === "FunctionName" &&
      isAstNode(definition.node) &&
      definition.node.type === "FunctionDeclaration"
    ) {
      return definition.node;
    }
    if (
      definition?.type !== "Variable" ||
      !isAstNode(definition.node) ||
      definition.node.type !== "VariableDeclarator" ||
      !isIdentifier(definition.node.id, identifier.name) ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "VariableDeclaration" ||
      definition.parent.kind !== "const"
    ) {
      return null;
    }
    const initializer = unwrapTS(definition.node.init);
    if (isFunctionNode(initializer)) {
      return initializer;
    }
    return this.isEstreeIdentifier(initializer)
      ? this.resolveLocalQueryFunction(initializer, visited)
      : null;
  };

  onProperty = (node) => {
    if (!isQueryFnProperty(node)) {
      return;
    }
    const expression = unwrapTS(node.value);
    if (this.isEstreeIdentifier(expression)) {
      this.queryFnReferences.push(expression);
    }
  };

  onCallExpression = (node) => {
    const kind = this.networkKind(node.callee);
    if (kind === null) {
      return;
    }
    const owner = nearestEnclosingFunction(node);
    if (!isAstNode(owner)) {
      return;
    }
    if (!isQueryFnFunction(owner)) {
      this.networkCalls.push({ kind, node, owner });
      return;
    }
    const bindingName = signalBindingName(owner);
    if (
      bindingName !== null &&
      callThreadsSignal({ bindingName, kind, node })
    ) {
      return;
    }
    this.context.report({ node, messageId: "missingQuerySignal" });
  };

  onProgramExit = () => {
    const queryFunctions = new Set();
    for (const reference of this.queryFnReferences) {
      const queryFunction = this.resolveLocalQueryFunction(reference);
      if (queryFunction !== null) {
        queryFunctions.add(queryFunction);
      }
    }
    for (const { kind, node, owner } of this.networkCalls) {
      if (!queryFunctions.has(owner)) {
        continue;
      }
      const bindingName = signalBindingName(owner);
      if (
        bindingName !== null &&
        callThreadsSignal({ bindingName, kind, node })
      ) {
        continue;
      }
      this.context.report({ node, messageId: "missingQuerySignal" });
    }
  };

  listeners() {
    return {
      Property: this.onProperty,
      CallExpression: this.onCallExpression,
      "Program:exit": this.onProgramExit,
    };
  }
}

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: { ...scopeProperties, apiModule: { type: "string" } },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      missingQuerySignal:
        "queryFn makes a network call without threading TanStack Query's " +
        "abort signal: destructure `signal` from the queryFn argument and " +
        "pass it through (`fetch(url, { signal })` or Eden's " +
        "`{ fetch: { signal } }`), or a superseded call can still resolve " +
        "and apply stale data after a newer one wins.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return new QuerySignalAnalysis(context).listeners();
  },
};
