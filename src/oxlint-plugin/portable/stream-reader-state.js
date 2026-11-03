import { findVariable } from "../shared/scope.js";
import { getPropertyName, isAstNode, isIdentifier } from "./ast.js";
import { isGlobalReference } from "./static-resolution.js";
import {
  isLiteralTrue,
  memberCall,
  staticMemberName,
  unwrapReaderExpression,
  visitNodes,
} from "./stream-reader-ast.js";
import { canWriteBinding } from "./stream-reader-cleanup.js";

const isConstDeclarator = (definition) =>
  definition.type === "Variable" &&
  isAstNode(definition.node) &&
  definition.node.type === "VariableDeclarator" &&
  isAstNode(definition.parent) &&
  definition.parent.type === "VariableDeclaration" &&
  definition.parent.kind === "const";

export class StreamReaderState {
  constructor(sourceCode) {
    this.sourceCode = sourceCode;
    this.resolveVariable = findVariable.bind(null, sourceCode);
    this.isGlobalReference = isGlobalReference.bind(null, sourceCode);
    this.canAssign = canWriteBinding.bind(null, this.resolveVariable);
  }
  isEstreeIdentifier = (node) =>
    isIdentifier(node) && Array.isArray(node.range);

  namedType = (node, name) => {
    const typeNode = isAstNode(node) ? node : null;
    if (typeNode === null) {
      return false;
    }
    if (
      typeNode.type === "TSTypeAnnotation" ||
      typeNode.type === "TSParenthesizedType" ||
      typeNode.type === "TSOptionalType"
    ) {
      return this.namedType(typeNode.typeAnnotation, name);
    }
    if (typeNode.type === "TSUnionType" && Array.isArray(typeNode.types)) {
      const meaningfulTypes = typeNode.types.filter(
        (part) =>
          isAstNode(part) &&
          part.type !== "TSNullKeyword" &&
          part.type !== "TSUndefinedKeyword"
      );
      return (
        meaningfulTypes.length > 0 &&
        meaningfulTypes.every((part) => this.namedType(part, name))
      );
    }
    return (
      typeNode.type === "TSTypeReference" &&
      isIdentifier(typeNode.typeName, name) &&
      this.isGlobalReference(typeNode.typeName, name)
    );
  };

  definitionName = (definition) => {
    if (isAstNode(definition.name)) {
      return definition.name;
    }
    if (
      isAstNode(definition.node) &&
      definition.node.type === "VariableDeclarator" &&
      isAstNode(definition.node.id)
    ) {
      return definition.node.id;
    }
    return null;
  };

  variableHasType = (bindingSymbol, name) =>
    bindingSymbol.defs.some((definition) => {
      const identifier = this.definitionName(definition);
      return (
        identifier !== null && this.namedType(identifier.typeAnnotation, name)
      );
    });

  constInitializer = (bindingSymbol) => {
    for (const definition of bindingSymbol.defs) {
      if (isConstDeclarator(definition)) {
        return isAstNode(definition.node.init) ? definition.node.init : null;
      }
    }
    return null;
  };

  responseBodyInitializer = (bindingSymbol) => {
    for (const definition of bindingSymbol.defs) {
      if (
        !isConstDeclarator(definition) ||
        !isAstNode(definition.node.id) ||
        definition.node.id.type !== "ObjectPattern" ||
        !isAstNode(definition.node.init)
      ) {
        continue;
      }
      const properties = Array.isArray(definition.node.id.properties)
        ? definition.node.id.properties
        : [];
      for (const property of properties) {
        if (
          !isAstNode(property) ||
          property.type !== "Property" ||
          getPropertyName(property.key) !== "body"
        ) {
          continue;
        }
        let target = unwrapReaderExpression(property.value);
        if (target?.type === "AssignmentPattern") {
          target = unwrapReaderExpression(target.left);
        }
        if (
          this.isEstreeIdentifier(target) &&
          this.resolveVariable(target) === bindingSymbol
        ) {
          return definition.node.init;
        }
      }
    }
    return null;
  };

  isGlobalConstructor = (node, name) => {
    const expression = unwrapReaderExpression(node);
    if (expression?.type !== "NewExpression") {
      return false;
    }
    if (this.isGlobalReference(expression.callee, name)) {
      return true;
    }
    const callee = unwrapReaderExpression(expression.callee);
    if (
      callee?.type !== "MemberExpression" ||
      staticMemberName(callee) !== name
    ) {
      return false;
    }
    return ["globalThis", "self", "window"].some((host) =>
      this.isGlobalReference(callee.object, host)
    );
  };

  isGlobalFetch = (node) => {
    const expression = unwrapReaderExpression(node);
    if (expression?.type !== "CallExpression") {
      return false;
    }
    if (this.isGlobalReference(expression.callee, "fetch")) {
      return true;
    }
    const callee = unwrapReaderExpression(expression.callee);
    if (
      callee?.type !== "MemberExpression" ||
      staticMemberName(callee) !== "fetch"
    ) {
      return false;
    }
    return ["globalThis", "self", "window"].some((host) =>
      this.isGlobalReference(callee.object, host)
    );
  };

  isBunStdinStream = (node) => {
    const matched = memberCall(node, "stream");
    const stdin =
      matched === null ? null : unwrapReaderExpression(matched.object);
    return (
      matched !== null &&
      Array.isArray(matched.call.arguments) &&
      matched.call.arguments.length === 0 &&
      stdin?.type === "MemberExpression" &&
      staticMemberName(stdin) === "stdin" &&
      this.isGlobalReference(stdin.object, "Bun")
    );
  };

  isResponseExpression = (node, visited = new Set()) => {
    const expression = unwrapReaderExpression(node);
    if (expression === null) {
      return false;
    }
    if (expression.type === "AwaitExpression") {
      return this.isGlobalFetch(expression.argument);
    }
    if (this.isGlobalConstructor(expression, "Response")) {
      return true;
    }
    if (!this.isEstreeIdentifier(expression)) {
      return false;
    }
    const bindingSymbol = this.resolveVariable(expression);
    if (bindingSymbol === null || visited.has(bindingSymbol)) {
      return false;
    }
    if (this.variableHasType(bindingSymbol, "Response")) {
      return true;
    }
    visited.add(bindingSymbol);
    const initializer = this.constInitializer(bindingSymbol);
    return (
      initializer !== null && this.isResponseExpression(initializer, visited)
    );
  };

  isReadableStreamExpression = (node, visited = new Set()) => {
    const expression = unwrapReaderExpression(node);
    if (expression === null) {
      return false;
    }
    if (this.isGlobalConstructor(expression, "ReadableStream")) {
      return true;
    }
    if (this.isBunStdinStream(expression)) {
      return true;
    }
    if (expression.type === "MemberExpression") {
      return (
        staticMemberName(expression) === "body" &&
        this.isResponseExpression(expression.object)
      );
    }
    if (!this.isEstreeIdentifier(expression)) {
      return false;
    }
    const bindingSymbol = this.resolveVariable(expression);
    if (bindingSymbol === null || visited.has(bindingSymbol)) {
      return false;
    }
    if (this.variableHasType(bindingSymbol, "ReadableStream")) {
      return true;
    }
    const responseInitializer = this.responseBodyInitializer(bindingSymbol);
    if (
      responseInitializer !== null &&
      this.isResponseExpression(responseInitializer)
    ) {
      return true;
    }
    visited.add(bindingSymbol);
    const initializer = this.constInitializer(bindingSymbol);
    return (
      initializer !== null &&
      this.isReadableStreamExpression(initializer, visited)
    );
  };

  canonicalBinding = (node, visited = new Set()) => {
    const expression = unwrapReaderExpression(node);
    if (!this.isEstreeIdentifier(expression)) {
      return null;
    }
    const bindingSymbol = this.resolveVariable(expression);
    if (bindingSymbol === null || visited.has(bindingSymbol)) {
      return bindingSymbol;
    }
    visited.add(bindingSymbol);
    const initializer = this.constInitializer(bindingSymbol);
    const aliased = this.canonicalBinding(initializer, visited);
    return aliased ?? bindingSymbol;
  };

  readerMethodCall = (node, method, binding) => {
    const matched = memberCall(node, method);
    return (
      matched !== null && this.canonicalBinding(matched.object) === binding
    );
  };

  containsReaderMethod = (node, method, binding) => {
    const root = unwrapReaderExpression(node);
    if (root === null) {
      return false;
    }
    let found = false;
    visitNodes(root, root, (candidate) => {
      if (this.readerMethodCall(candidate, method, binding)) {
        found = true;
      }
    });
    return found;
  };

  acquisitionOwner = (node) => {
    let current = node;
    let parent = isAstNode(current.parent) ? current.parent : null;
    while (
      parent !== null &&
      (parent.type === "TSAsExpression" ||
        parent.type === "TSNonNullExpression" ||
        parent.type === "TSSatisfiesExpression" ||
        parent.type === "TSTypeAssertion")
    ) {
      current = parent;
      parent = isAstNode(current.parent) ? current.parent : null;
    }
    if (
      parent?.type === "VariableDeclarator" &&
      parent.init === current &&
      this.isEstreeIdentifier(parent.id)
    ) {
      const declaration = isAstNode(parent.parent) ? parent.parent : null;
      return {
        binding: this.resolveVariable(parent.id),
        stable:
          declaration?.type === "VariableDeclaration" &&
          declaration.kind === "const",
      };
    }
    if (
      parent?.type === "AssignmentExpression" &&
      parent.right === current &&
      this.isEstreeIdentifier(parent.left)
    ) {
      return { binding: this.resolveVariable(parent.left), stable: false };
    }
    return { binding: null, stable: false };
  };

  readResultKind = (identifier, binding) => {
    const bindingSymbol = this.resolveVariable(identifier);
    if (bindingSymbol === null) {
      return null;
    }
    if (
      bindingSymbol.references.some(
        (reference) => reference.init !== true && reference.isWrite?.() === true
      )
    ) {
      return null;
    }
    for (const definition of bindingSymbol.defs) {
      if (!isConstDeclarator(definition)) continue;
      let initializer = unwrapReaderExpression(definition.node.init);
      if (initializer?.type === "AwaitExpression") {
        initializer = unwrapReaderExpression(initializer.argument);
      }
      if (!this.readerMethodCall(initializer, "read", binding)) {
        continue;
      }
      if (isIdentifier(definition.node.id, identifier.name)) {
        return "result";
      }
      if (
        isAstNode(definition.node.id) &&
        definition.node.id.type === "ObjectPattern" &&
        Array.isArray(definition.node.id.properties) &&
        definition.node.id.properties.some(
          (property) =>
            isAstNode(property) &&
            property.type === "Property" &&
            getPropertyName(property.key) === "done" &&
            isIdentifier(property.value, identifier.name)
        )
      ) {
        return "done";
      }
    }
    return null;
  };

  isDoneGuard = (node, binding) => {
    const expression = unwrapReaderExpression(node);
    if (this.isEstreeIdentifier(expression)) {
      return this.readResultKind(expression, binding) === "done";
    }
    if (
      expression?.type === "MemberExpression" &&
      staticMemberName(expression) === "done" &&
      this.isEstreeIdentifier(unwrapReaderExpression(expression.object))
    ) {
      const object = unwrapReaderExpression(expression.object);
      return (
        this.isEstreeIdentifier(object) &&
        this.readResultKind(object, binding) === "result"
      );
    }
    if (
      expression?.type === "BinaryExpression" &&
      (expression.operator === "===" || expression.operator === "==")
    ) {
      return (
        (this.isDoneGuard(expression.left, binding) &&
          isLiteralTrue(expression.right)) ||
        (isLiteralTrue(expression.left) &&
          this.isDoneGuard(expression.right, binding))
      );
    }
    return false;
  };
}
