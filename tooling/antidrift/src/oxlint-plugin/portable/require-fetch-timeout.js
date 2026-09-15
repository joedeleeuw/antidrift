import { findVariable } from "./imported-owner.js";
import { isRuleFile, scopeProperties } from "./scope.js";
import { getPropertyName, isIdentifier } from "./ast.js";

const getNodeType = (node) => {
  if (typeof node !== "object" || node === null || !("type" in node)) {
    return null;
  }
  return typeof node.type === "string" ? node.type : null;
};
const getNodeArguments = (node) => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("arguments" in node) ||
    !Array.isArray(node.arguments)
  ) {
    return null;
  }
  return node.arguments.map((value) => value);
};
const unwrapExpression = (node) => {
  let current = node;
  while (
    getNodeType(current) === "TSAsExpression" ||
    getNodeType(current) === "TSSatisfiesExpression" ||
    getNodeType(current) === "TSNonNullExpression" ||
    getNodeType(current) === "TypeCastExpression"
  ) {
    if (
      typeof current !== "object" ||
      current === null ||
      !("expression" in current)
    ) {
      return current;
    }
    current = current.expression;
  }
  return current;
};
const getObjectExpressionProperties = (node) => {
  const unwrapped = unwrapExpression(node);
  if (
    getNodeType(unwrapped) !== "ObjectExpression" ||
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    !("properties" in unwrapped) ||
    !Array.isArray(unwrapped.properties)
  ) {
    return null;
  }
  return unwrapped.properties.map((value) => value);
};
const getPropertyKey = (node) => {
  if (typeof node !== "object" || node === null || !("key" in node)) {
    return null;
  }
  return node.key;
};
const getIdentifierName = (node) => {
  const unwrapped = unwrapExpression(node);
  if (
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    getNodeType(unwrapped) !== "Identifier" ||
    !("name" in unwrapped) ||
    typeof unwrapped.name !== "string"
  ) {
    return null;
  }
  return unwrapped.name;
};
const getBindingIdentifierNames = (node) => {
  const value = unwrapExpression(node);
  if (!value) return [];
  if (value.type === "Identifier") return [value.name];
  if (value.type === "RestElement") {
    return getBindingIdentifierNames(value.argument);
  }
  if (value.type === "AssignmentPattern") {
    return getBindingIdentifierNames(value.left);
  }
  if (value.type === "ArrayPattern") {
    return value.elements.flatMap(getBindingIdentifierNames);
  }
  if (value.type === "ObjectPattern") {
    return value.properties.flatMap((property) =>
      getBindingIdentifierNames(
        property.type === "RestElement" ? property.argument : property.value,
      ),
    );
  }
  return [];
};
const getNodeInit = (node) => {
  if (typeof node !== "object" || node === null || !("init" in node)) {
    return null;
  }
  return node.init;
};
const getNodeId = (node) => {
  if (typeof node !== "object" || node === null || !("id" in node)) {
    return null;
  }
  return node.id;
};
const getNodeLeft = (node) => {
  if (typeof node !== "object" || node === null || !("left" in node)) {
    return null;
  }
  return node.left;
};
const getNodeRight = (node) => {
  if (typeof node !== "object" || node === null || !("right" in node)) {
    return null;
  }
  return node.right;
};
const getNodeParams = (node) => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("params" in node) ||
    !Array.isArray(node.params)
  ) {
    return [];
  }
  return node.params.map((value) => value);
};
const isFetchCallee = (callee) => {
  if (isIdentifier(callee, "fetch")) {
    return true;
  }
  if (
    typeof callee !== "object" ||
    callee === null ||
    callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const member = callee;
  if (member.computed !== false) {
    return false;
  }
  if (!isIdentifier(member.property, "fetch")) {
    return false;
  }
  return (
    isIdentifier(member.object, "globalThis") ||
    isIdentifier(member.object, "window") ||
    isIdentifier(member.object, "self") ||
    isIdentifier(member.object, "global")
  );
};
const isRequestConstructorExpression = (node) => {
  const unwrapped = unwrapExpression(node);
  return (
    getNodeType(unwrapped) === "NewExpression" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "callee" in unwrapped &&
    isIdentifier(unwrapped.callee, "Request")
  );
};
const requestConstructorSignalState = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!isRequestConstructorExpression(unwrapped)) {
    return null;
  }
  const requestArguments = getNodeArguments(unwrapped);
  if (requestArguments === null) {
    return "no";
  }
  const init = requestArguments.at(1);
  if (init === undefined) {
    return "no";
  }
  if (getNodeType(init) !== "ObjectExpression") {
    return "opaque";
  }
  return optionsObjectHasSignal(init);
};
const isRequestTypeAnnotation = (node) => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("typeAnnotation" in node) ||
    typeof node.typeAnnotation !== "object" ||
    node.typeAnnotation === null ||
    !("typeAnnotation" in node.typeAnnotation)
  ) {
    return false;
  }
  const annotation = node.typeAnnotation.typeAnnotation;
  if (
    typeof annotation !== "object" ||
    annotation === null ||
    getNodeType(annotation) !== "TSTypeReference" ||
    !("typeName" in annotation)
  ) {
    return false;
  }
  return isIdentifier(annotation.typeName, "Request");
};
const optionsObjectHasSignal = (options) => {
  const properties = getObjectExpressionProperties(options);
  if (properties === null) {
    return "opaque";
  }
  for (const prop of properties) {
    const propType = getNodeType(prop);
    if (propType === "SpreadElement") {
      return "opaque";
    }
    if (propType !== "Property") {
      continue;
    }
    if (getPropertyName(getPropertyKey(prop)) === "signal") {
      return "yes";
    }
  }
  return "no";
};
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      missingSignal:
        "fetch() must pass `signal` (e.g. " +
        "`{ signal: AbortSignal.timeout(10_000) }`) so upstream " +
        "hangs cannot stall the handler.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    function fetchOrigin(node, seen = new Set()) {
      node = unwrapExpression(node);
      if (node?.type !== "Identifier") return isFetchCallee(node);
      const variable = findVariable(context, node);
      if (!variable?.defs.length) return node.name === "fetch";
      if (seen.has(variable)) return false;
      seen.add(variable);
      const definition = variable.defs[0];
      const id =
        definition.node.type === "AssignmentPattern"
          ? definition.node.left
          : definition.name;
      const annotation = id?.typeAnnotation?.typeAnnotation;
      if (
        annotation?.type === "TSTypeQuery" &&
        isIdentifier(annotation.exprName, "fetch")
      ) {
        return true;
      }
      if (
        definition.type === "Variable" &&
        definition.parent.kind === "const" &&
        !variable.references.some(
          (reference) => reference.isWrite() && !reference.init,
        )
      ) {
        return fetchOrigin(definition.node.init, seen);
      }
      if (
        definition.type === "Parameter" &&
        definition.name?.parent?.type === "AssignmentPattern"
      ) {
        return fetchOrigin(definition.name.parent.right, seen);
      }
      return false;
    }

    const requestSignalScopes = [];
    const pushRequestSignalScope = () => {
      requestSignalScopes.push(new Map());
    };
    const popRequestSignalScope = () => {
      requestSignalScopes.pop();
      if (requestSignalScopes.length === 0) {
        pushRequestSignalScope();
      }
    };
    const currentRequestSignalScope = () => {
      const scope = requestSignalScopes.at(-1);
      if (scope) {
        return scope;
      }
      pushRequestSignalScope();
      return currentRequestSignalScope();
    };
    const getRequestSignalState = (name) => {
      for (let index = requestSignalScopes.length - 1; index >= 0; index -= 1) {
        const scope = requestSignalScopes.at(index);
        const state = scope?.get(name);
        if (state !== undefined) {
          return state;
        }
      }
      return "no";
    };
    const setRequestSignalState = (name, state) => {
      currentRequestSignalScope().set(name, state);
    };
    const assignRequestSignalState = (name, state) => {
      for (let index = requestSignalScopes.length - 1; index >= 0; index -= 1) {
        const scope = requestSignalScopes.at(index);
        if (scope?.has(name)) {
          scope.set(name, state);
          return;
        }
      }
      setRequestSignalState(name, state);
    };
    const declareFunctionParameters = (node) => {
      for (const param of getNodeParams(node)) {
        for (const identifierName of getBindingIdentifierNames(param)) {
          setRequestSignalState(identifierName, "no");
        }
      }
    };
    const getFetchInputSignalState = (input) => {
      const constructorSignal = requestConstructorSignalState(input);
      if (constructorSignal !== null) {
        return constructorSignal;
      }
      const identifierName = getIdentifierName(input);
      if (identifierName === null) {
        return "no";
      }
      return getRequestSignalState(identifierName);
    };
    if (
      (() => {
        requestSignalScopes.length = 0;
      })() === false
    ) {
      return {};
    }
    return {
      Program() {
        requestSignalScopes.length = 0;
        pushRequestSignalScope();
      },
      "Program:exit"() {
        requestSignalScopes.length = 0;
      },
      BlockStatement() {
        pushRequestSignalScope();
      },
      "BlockStatement:exit"() {
        popRequestSignalScope();
      },
      FunctionDeclaration(node) {
        pushRequestSignalScope();
        declareFunctionParameters(node);
      },
      "FunctionDeclaration:exit"() {
        popRequestSignalScope();
      },
      FunctionExpression(node) {
        pushRequestSignalScope();
        declareFunctionParameters(node);
      },
      "FunctionExpression:exit"() {
        popRequestSignalScope();
      },
      ArrowFunctionExpression(node) {
        pushRequestSignalScope();
        declareFunctionParameters(node);
      },
      "ArrowFunctionExpression:exit"() {
        popRequestSignalScope();
      },
      CatchClause(node) {
        pushRequestSignalScope();
        const param =
          typeof node === "object" && node !== null && "param" in node
            ? node.param
            : null;
        for (const identifierName of getBindingIdentifierNames(param)) {
          setRequestSignalState(identifierName, "no");
        }
      },
      "CatchClause:exit"() {
        popRequestSignalScope();
      },
      VariableDeclarator(node) {
        const id = getNodeId(node);
        const identifierName = getIdentifierName(id);
        const bindingNames = getBindingIdentifierNames(id);
        if (bindingNames.length === 0) {
          return;
        }
        const initSignal = requestConstructorSignalState(getNodeInit(node));
        if (identifierName !== null && initSignal !== null) {
          setRequestSignalState(identifierName, initSignal);
          return;
        }
        if (identifierName !== null && isRequestTypeAnnotation(id)) {
          setRequestSignalState(identifierName, "opaque");
          return;
        }
        for (const bindingName of bindingNames) {
          setRequestSignalState(bindingName, "no");
        }
      },
      AssignmentExpression(node) {
        const left = getNodeLeft(node);
        const identifierName = getIdentifierName(left);
        if (identifierName === null) {
          for (const bindingName of getBindingIdentifierNames(left)) {
            assignRequestSignalState(bindingName, "no");
          }
          return;
        }
        const rightSignal = requestConstructorSignalState(getNodeRight(node));
        if (rightSignal !== null) {
          assignRequestSignalState(identifierName, rightSignal);
          return;
        }
        const nextState =
          getRequestSignalState(identifierName) === "opaque" ? "opaque" : "no";
        assignRequestSignalState(identifierName, nextState);
      },
      CallExpression(node) {
        if (!fetchOrigin(node.callee)) {
          return;
        }
        const [firstArg, options] = node.arguments;
        if (options === undefined) {
          if (getFetchInputSignalState(firstArg) !== "no") {
            return;
          }
          context.report({ node, messageId: "missingSignal" });
          return;
        }
        const unwrappedOptions = unwrapExpression(options);
        if (getNodeType(unwrappedOptions) !== "ObjectExpression") {
          return;
        }
        if (
          optionsObjectHasSignal(unwrappedOptions) === "no" &&
          getFetchInputSignalState(firstArg) === "no"
        ) {
          context.report({ node, messageId: "missingSignal" });
        }
      },
    };
  },
};
