import { isRuleFile, scopeProperties } from "./scope.js";
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
      getPropertyName(sibling.key) === "queryKey",
  );
};
const isQueryFnFunction = (fn) => {
  const property = skipWrapperAncestors(fn.parent);
  return isQueryFnProperty(property);
};
const signalBindingName = (fn) => {
  const firstParam = fn.params?.at(0);
  if (firstParam?.type !== "ObjectPattern") {
    return null;
  }
  const signalProperty = firstParam.properties.find(
    (property) =>
      property?.type === "Property" &&
      getPropertyName(property.key) === "signal",
  );
  const value = unwrapTS(signalProperty?.value);
  if (value?.type === "Identifier") {
    return value.name;
  }
  if (value?.type === "AssignmentPattern") {
    const left = unwrapTS(value.left);
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
  return Object.entries(unwrapped).some(([key, value]) => {
    if (key === "parent") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsSignalIdentifier(item, bindingName));
    }
    return containsSignalIdentifier(value, bindingName);
  });
};
const getObjectPropertyValue = (node, name) => {
  const object = unwrapTS(node);
  if (object?.type !== "ObjectExpression") {
    return null;
  }
  const property = object.properties.find(
    (candidate) =>
      candidate?.type === "Property" && getPropertyName(candidate.key) === name,
  );
  return property?.value ?? null;
};
const callThreadsSignal = ({ bindingName, kind, node }) => {
  const call = isAstNode(node) && node.type === "CallExpression" ? node : null;
  const argumentsList =
    call !== null && Array.isArray(call.arguments) ? call.arguments : [];
  if (kind === "fetch") {
    return containsSignalIdentifier(
      getObjectPropertyValue(argumentsList.at(1), "signal"),
      bindingName,
    );
  }
  return argumentsList.some((argument) =>
    containsSignalIdentifier(
      getObjectPropertyValue(
        getObjectPropertyValue(argument, "fetch"),
        "signal",
      ),
      bindingName,
    ),
  );
};
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

    const networkCalls = [];
    const queryFnReferences = [];
    const isEstreeIdentifier = (node) =>
      isIdentifier(node) && Array.isArray(node.range);
    const resolveVariable = (identifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    };
    const isGlobalReference = (node, name) => {
      if (!isEstreeIdentifier(node) || node.name !== name) {
        return false;
      }
      const variable = resolveVariable(node);
      return variable === null || variable.defs.length === 0;
    };
    const isEdenApiRoot = (node) => {
      if (!isEstreeIdentifier(node)) {
        return false;
      }
      const variable = resolveVariable(node);
      if (variable === null || variable.defs.length !== 1) {
        return false;
      }
      const definition = variable.defs.at(0);
      return (
        definition?.type === "ImportBinding" &&
        isAstNode(definition.node) &&
        getImportedName(definition.node) === "api" &&
        isAstNode(definition.parent) &&
        definition.parent.type === "ImportDeclaration" &&
        isStringLiteral(definition.parent.source) &&
        definition.parent.source.value === context.options[0]?.apiModule
      );
    };
    const networkKind = (callee) => {
      if (isFetchCallee(callee, isGlobalReference)) {
        return "fetch";
      }
      return isEdenApiCallee(callee, isEdenApiRoot) ? "eden" : null;
    };
    const hasReassignment = (variable) =>
      variable.references.some(
        (reference) =>
          reference.init !== true && reference.isWrite?.() === true,
      );
    const resolveLocalQueryFunction = (identifier, visited = new Set()) => {
      const variable = resolveVariable(identifier);
      if (
        variable === null ||
        variable.defs.length !== 1 ||
        visited.has(variable) ||
        hasReassignment(variable)
      ) {
        return null;
      }
      visited.add(variable);
      const definition = variable.defs.at(0);
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
      return isEstreeIdentifier(initializer)
        ? resolveLocalQueryFunction(initializer, visited)
        : null;
    };
    if (
      (() => {
        networkCalls.length = 0;
        queryFnReferences.length = 0;
      })() === false
    ) {
      return {};
    }
    return {
      Property(node) {
        if (!isQueryFnProperty(node)) {
          return;
        }
        const value = unwrapTS(node.value);
        if (isEstreeIdentifier(value)) {
          queryFnReferences.push(value);
        }
      },
      CallExpression(node) {
        const kind = networkKind(node.callee);
        if (kind === null) {
          return;
        }
        const owner = nearestEnclosingFunction(node);
        if (!isAstNode(owner)) {
          return;
        }
        if (!isQueryFnFunction(owner)) {
          networkCalls.push({ kind, node, owner });
          return;
        }
        const bindingName = signalBindingName(owner);
        if (
          bindingName !== null &&
          callThreadsSignal({ bindingName, kind, node })
        ) {
          return;
        }
        context.report({ node, messageId: "missingQuerySignal" });
      },
      "Program:exit"() {
        const queryFunctions = new Set();
        for (const reference of queryFnReferences) {
          const queryFunction = resolveLocalQueryFunction(reference);
          if (queryFunction !== null) {
            queryFunctions.add(queryFunction);
          }
        }
        for (const { kind, node, owner } of networkCalls) {
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
          context.report({ node, messageId: "missingQuerySignal" });
        }
      },
    };
  },
};
