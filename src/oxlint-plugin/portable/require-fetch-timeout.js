import { findVariable, unwrapExpression } from "../shared/scope.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
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
  return node.arguments.map((element) => element);
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
  return unwrapped.properties.map((element) => element);
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
  const element = unwrapExpression(node);
  if (!element) return [];
  if (element.type === "Identifier") return [element.name];
  if (element.type === "RestElement") {
    return getBindingIdentifierNames(element.argument);
  }
  if (element.type === "AssignmentPattern") {
    return getBindingIdentifierNames(element.left);
  }
  if (element.type === "ArrayPattern") {
    return element.elements.flatMap(getBindingIdentifierNames);
  }
  if (element.type === "ObjectPattern") {
    return element.properties.flatMap((property) =>
      getBindingIdentifierNames(
        property.type === "RestElement" ? property.argument : property.value
      )
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
  return node.params.map((element) => element);
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
class FetchSignalAnalysis {
  constructor(context) {
    this.context = context;
    this.requestSignalScopes = [];
  }
  fetchOrigin = (rawNode, seen = new Set()) => {
    const node = unwrapExpression(rawNode);
    if (node?.type !== "Identifier") return isFetchCallee(node);
    const bindingSymbol = findVariable(this.context.sourceCode, node);
    if (!bindingSymbol?.defs.length) return node.name === "fetch";
    if (seen.has(bindingSymbol)) return false;
    seen.add(bindingSymbol);
    const definition = bindingSymbol.defs[0];
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
      !bindingSymbol.references.some(
        (reference) => reference.isWrite() && !reference.init
      )
    ) {
      return this.fetchOrigin(definition.node.init, seen);
    }
    if (
      definition.type === "Parameter" &&
      definition.name?.parent?.type === "AssignmentPattern"
    ) {
      return this.fetchOrigin(definition.name.parent.right, seen);
    }
    return false;
  };

  pushRequestSignalScope = () => {
    this.requestSignalScopes.push(new Map());
  };

  popRequestSignalScope = () => {
    this.requestSignalScopes.pop();
    if (this.requestSignalScopes.length === 0) {
      this.pushRequestSignalScope();
    }
  };

  currentRequestSignalScope = () => {
    const scope = this.requestSignalScopes.at(-1);
    if (scope) {
      return scope;
    }
    this.pushRequestSignalScope();
    return this.currentRequestSignalScope();
  };

  getRequestSignalState = (name) => {
    for (
      let index = this.requestSignalScopes.length - 1;
      index >= 0;
      index -= 1
    ) {
      const scope = this.requestSignalScopes.at(index);
      const state = scope?.get(name);
      if (state !== undefined) {
        return state;
      }
    }
    return "no";
  };

  setRequestSignalState = (name, state) => {
    this.currentRequestSignalScope().set(name, state);
  };

  assignRequestSignalState = (name, state) => {
    for (
      let index = this.requestSignalScopes.length - 1;
      index >= 0;
      index -= 1
    ) {
      const scope = this.requestSignalScopes.at(index);
      if (scope?.has(name)) {
        scope.set(name, state);
        return;
      }
    }
    this.setRequestSignalState(name, state);
  };

  declareFunctionParameters = (node) => {
    for (const parameter of getNodeParams(node)) {
      for (const identifierName of getBindingIdentifierNames(parameter)) {
        this.setRequestSignalState(identifierName, "no");
      }
    }
  };

  getFetchInputSignalState = (input) => {
    const constructorSignal = requestConstructorSignalState(input);
    if (constructorSignal !== null) {
      return constructorSignal;
    }
    const identifierName = getIdentifierName(input);
    if (identifierName === null) {
      return "no";
    }
    return this.getRequestSignalState(identifierName);
  };

  onProgram = () => {
    this.requestSignalScopes.length = 0;
    this.pushRequestSignalScope();
  };

  onProgramExit = () => {
    this.requestSignalScopes.length = 0;
  };

  enterFunction = (node) => {
    this.pushRequestSignalScope();
    this.declareFunctionParameters(node);
  };

  onCatchClause = (node) => {
    this.pushRequestSignalScope();
    const parameter =
      typeof node === "object" && node !== null && "param" in node
        ? node.param
        : null;
    for (const identifierName of getBindingIdentifierNames(parameter)) {
      this.setRequestSignalState(identifierName, "no");
    }
  };

  onVariableDeclarator = (node) => {
    const id = getNodeId(node);
    const identifierName = getIdentifierName(id);
    const bindingNames = getBindingIdentifierNames(id);
    if (bindingNames.length === 0) {
      return;
    }
    const initSignal = requestConstructorSignalState(getNodeInit(node));
    if (identifierName !== null && initSignal !== null) {
      this.setRequestSignalState(identifierName, initSignal);
      return;
    }
    if (identifierName !== null && isRequestTypeAnnotation(id)) {
      this.setRequestSignalState(identifierName, "opaque");
      return;
    }
    for (const bindingName of bindingNames) {
      this.setRequestSignalState(bindingName, "no");
    }
  };

  onAssignmentExpression = (node) => {
    const left = getNodeLeft(node);
    const identifierName = getIdentifierName(left);
    if (identifierName === null) {
      for (const bindingName of getBindingIdentifierNames(left)) {
        this.assignRequestSignalState(bindingName, "no");
      }
      return;
    }
    const rightSignal = requestConstructorSignalState(getNodeRight(node));
    if (rightSignal !== null) {
      this.assignRequestSignalState(identifierName, rightSignal);
      return;
    }
    const nextState =
      this.getRequestSignalState(identifierName) === "opaque" ? "opaque" : "no";
    this.assignRequestSignalState(identifierName, nextState);
  };

  onCallExpression = (node) => {
    if (!this.fetchOrigin(node.callee)) {
      return;
    }
    const [firstArg, options] = node.arguments;
    if (options === undefined) {
      if (this.getFetchInputSignalState(firstArg) !== "no") {
        return;
      }
      this.context.report({ node, messageId: "missingSignal" });
      return;
    }
    const unwrappedOptions = unwrapExpression(options);
    if (getNodeType(unwrappedOptions) !== "ObjectExpression") {
      return;
    }
    if (
      optionsObjectHasSignal(unwrappedOptions) === "no" &&
      this.getFetchInputSignalState(firstArg) === "no"
    ) {
      this.context.report({ node, messageId: "missingSignal" });
    }
  };

  listeners() {
    return {
      Program: this.onProgram,
      "Program:exit": this.onProgramExit,
      BlockStatement: this.pushRequestSignalScope,
      "BlockStatement:exit": this.popRequestSignalScope,
      FunctionDeclaration: this.enterFunction,
      "FunctionDeclaration:exit": this.popRequestSignalScope,
      FunctionExpression: this.enterFunction,
      "FunctionExpression:exit": this.popRequestSignalScope,
      ArrowFunctionExpression: this.enterFunction,
      "ArrowFunctionExpression:exit": this.popRequestSignalScope,
      CatchClause: this.onCatchClause,
      "CatchClause:exit": this.popRequestSignalScope,
      VariableDeclarator: this.onVariableDeclarator,
      AssignmentExpression: this.onAssignmentExpression,
      CallExpression: this.onCallExpression,
    };
  }
}

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
    return new FetchSignalAnalysis(context).listeners();
  },
};
