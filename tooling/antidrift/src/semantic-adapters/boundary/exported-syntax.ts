import { AST_NODE_TYPES } from "@typescript-eslint/types";
import type { ParserNode, ParserFunction } from "../kernel/syntax-node.ts";
import { getFunctionNode, memberNodeTypes } from "../kernel/syntax-function.ts";
import {
  identifierName,
  isSyntaxType,
  syntaxChildren,
  syntaxField,
  unwrapExpression,
} from "../kernel/syntax-node.ts";
import { functionReturnsJsx } from "../kernel/jsx-returns.ts";

const exportedLocalNamesByProgram = new WeakMap<
  Extract<
    ParserNode,
    {
      type: AST_NODE_TYPES.Program;
    }
  >,
  Set<string>
>();
function isMember(node: ParserNode | null | undefined): node is Extract<
  ParserNode,
  {
    type:
      | AST_NODE_TYPES.MethodDefinition
      | AST_NODE_TYPES.PropertyDefinition
      | AST_NODE_TYPES.Property;
  }
> {
  return node !== null && node !== undefined && memberNodeTypes.has(node.type);
}
function isParserFunction(
  node: ParserNode | null | undefined
): node is ParserFunction {
  return (
    node?.type === AST_NODE_TYPES.FunctionDeclaration ||
    node?.type === AST_NODE_TYPES.FunctionExpression ||
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression
  );
}
function getFunctionName(node: ParserNode) {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return node.id?.name ?? "";
  }
  if (
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return node.type === AST_NODE_TYPES.FunctionExpression
      ? (node.id?.name ?? "")
      : "";
  }
  if (
    node.type === AST_NODE_TYPES.VariableDeclarator &&
    node.id.type === AST_NODE_TYPES.Identifier
  ) {
    return node.id.name;
  }
  if (isMember(node)) {
    const key = node.key;
    if (
      key.type === AST_NODE_TYPES.Identifier ||
      key.type === AST_NODE_TYPES.PrivateIdentifier
    ) {
      return key.name;
    }
    if (key.type === AST_NODE_TYPES.Literal && typeof key.value === "string") {
      return key.value;
    }
  }
  return "";
}
function declarationName(node: ParserNode) {
  if (
    node.type === AST_NODE_TYPES.VariableDeclarator &&
    node.id.type === AST_NODE_TYPES.Identifier
  ) {
    return node.id.name;
  }
  if (
    (node.type === AST_NODE_TYPES.FunctionDeclaration ||
      node.type === AST_NODE_TYPES.ClassDeclaration) &&
    node.id?.type === AST_NODE_TYPES.Identifier
  ) {
    return node.id.name;
  }
  return getFunctionName(node);
}
function programNode(node: ParserNode) {
  let ancestor = node;
  while (ancestor.parent) {
    ancestor = ancestor.parent;
  }
  return ancestor;
}
function exportedLocalNames(
  program: Extract<
    ParserNode,
    {
      type: AST_NODE_TYPES.Program;
    }
  >
) {
  const cached = exportedLocalNamesByProgram.get(program);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) {
      for (const specifier of statement.specifiers) {
        if (specifier.local.type === AST_NODE_TYPES.Identifier) {
          names.add(specifier.local.name);
        }
      }
    } else if (
      statement.type === AST_NODE_TYPES.ExportDefaultDeclaration &&
      statement.declaration.type === AST_NODE_TYPES.Identifier
    ) {
      names.add(statement.declaration.name);
    }
  }
  exportedLocalNamesByProgram.set(program, names);
  return names;
}
function isExported(node: ParserNode) {
  if (
    node.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    node.parent?.type === AST_NODE_TYPES.ExportDefaultDeclaration
  ) {
    return true;
  }
  const name = declarationName(node);
  return Boolean(name && exportedLocalNames(programNode(node)).has(name));
}
function enclosingClassExported(memberNode: ParserNode) {
  const classNode = memberNode.parent?.parent;
  if (
    classNode?.type !== AST_NODE_TYPES.ClassDeclaration &&
    classNode?.type !== AST_NODE_TYPES.ClassExpression
  ) {
    return false;
  }
  if (
    classNode.parent.type === AST_NODE_TYPES.ExportNamedDeclaration ||
    classNode.parent.type === AST_NODE_TYPES.ExportDefaultDeclaration
  ) {
    return true;
  }
  return (
    classNode.parent.type === AST_NODE_TYPES.VariableDeclarator &&
    classNode.parent.parent.parent.type ===
      AST_NODE_TYPES.ExportNamedDeclaration
  );
}
function outermostTypeWrapper(node: ParserNode) {
  let ancestor = node;
  while (
    (ancestor.parent?.type === AST_NODE_TYPES.TSSatisfiesExpression ||
      ancestor.parent?.type === AST_NODE_TYPES.TSAsExpression) &&
    ancestor.parent.expression === ancestor
  ) {
    ancestor = ancestor.parent;
  }
  return ancestor;
}
function enclosingObjectExported(memberNode: ParserNode) {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }
  const owned = outermostTypeWrapper(objectNode);
  if (owned.parent?.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
    return true;
  }
  return (
    owned.parent?.type === AST_NODE_TYPES.VariableDeclarator &&
    owned.parent.init === owned &&
    isBoundary(owned.parent)
  );
}
function enclosingReturnedObjectFromBoundary(memberNode: ParserNode): boolean {
  const objectNode = memberNode.parent;
  if (objectNode?.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }
  if (
    objectNode.parent.type === AST_NODE_TYPES.ArrowFunctionExpression &&
    objectNode.parent.body === objectNode
  ) {
    const arrowParent = objectNode.parent.parent;
    if (arrowParent.type === AST_NODE_TYPES.VariableDeclarator) {
      return isBoundary(arrowParent);
    }
    return isBoundary(objectNode.parent);
  }
  if (objectNode.parent.type !== AST_NODE_TYPES.ReturnStatement) {
    return false;
  }
  let ancestor: ParserNode | undefined = objectNode.parent.parent;
  while (ancestor) {
    if (ancestor.type === AST_NODE_TYPES.FunctionDeclaration) {
      return isBoundary(ancestor);
    }
    if (
      (ancestor.type === AST_NODE_TYPES.FunctionExpression ||
        ancestor.type === AST_NODE_TYPES.ArrowFunctionExpression) &&
      ancestor.parent.type === AST_NODE_TYPES.VariableDeclarator
    ) {
      return isBoundary(ancestor.parent);
    }
    if (isMember(ancestor)) {
      return isBoundary(ancestor);
    }
    ancestor = ancestor.parent;
  }
  return false;
}
function functionBoundaryNode(functionNode: ParserFunction) {
  if (functionNode.type === AST_NODE_TYPES.FunctionDeclaration) {
    return functionNode;
  }
  const owned = outermostTypeWrapper(functionNode);
  if (
    owned.parent?.type === AST_NODE_TYPES.VariableDeclarator &&
    owned.parent.init === owned
  ) {
    return owned.parent;
  }
  if (isMember(functionNode.parent)) {
    return functionNode.parent;
  }
  return functionNode;
}
function enclosingFunction(node: ParserNode) {
  let ancestor = node.parent;
  while (ancestor) {
    if (
      ancestor.type === AST_NODE_TYPES.FunctionDeclaration ||
      ancestor.type === AST_NODE_TYPES.FunctionExpression ||
      ancestor.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return ancestor;
    }
    ancestor = ancestor.parent;
  }
  return null;
}
function objectExpressionExposesIdentifier(objectNode: unknown, name: string) {
  if (!isSyntaxType(objectNode, AST_NODE_TYPES.ObjectExpression)) {
    return false;
  }
  return syntaxChildren(objectNode, "properties").some(
    (property) =>
      isSyntaxType(property, AST_NODE_TYPES.Property) &&
      (identifierName(syntaxField(property, "value")) === name ||
        Boolean(
          syntaxField(property, "shorthand") &&
          identifierName(syntaxField(property, "key")) === name
        ))
  );
}
function returnedObjectExposesIdentifier(
  functionNode: ParserFunction,
  name: string
) {
  if (functionNode.body.type === AST_NODE_TYPES.ObjectExpression) {
    return objectExpressionExposesIdentifier(functionNode.body, name);
  }
  if (functionNode.body.type !== AST_NODE_TYPES.BlockStatement) {
    return false;
  }
  return functionNode.body.body.some(
    (statement) =>
      statement.type === AST_NODE_TYPES.ReturnStatement &&
      objectExpressionExposesIdentifier(
        unwrapExpression(statement.argument),
        name
      )
  );
}
function callableReturnedFromBoundaryFactory(
  node: Extract<
    ParserNode,
    {
      type:
        | AST_NODE_TYPES.VariableDeclarator
        | AST_NODE_TYPES.FunctionDeclaration;
    }
  >
) {
  const name =
    node.id?.type === AST_NODE_TYPES.Identifier ? node.id.name : null;
  if (!name) {
    return false;
  }
  const functionNode = getFunctionNode(node);
  if (!functionNode) {
    return false;
  }
  const owner = enclosingFunction(node);
  if (!owner || !isBoundary(functionBoundaryNode(owner))) {
    return false;
  }
  return returnedObjectExposesIdentifier(owner, name);
}
export function isBoundary(node: ParserNode): boolean {
  if (!isMember(node)) {
    if (isExported(node)) {
      return true;
    }
    if (
      (node.type === AST_NODE_TYPES.VariableDeclarator ||
        node.type === AST_NODE_TYPES.FunctionDeclaration) &&
      callableReturnedFromBoundaryFactory(node)
    ) {
      return true;
    }
    return (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.parent.parent.type === AST_NODE_TYPES.ExportNamedDeclaration
    );
  }
  if (
    "kind" in node &&
    (node.kind === "get" || node.kind === "set" || node.kind === "constructor")
  ) {
    return true;
  }
  if (node.type === AST_NODE_TYPES.Property) {
    return (
      enclosingObjectExported(node) || enclosingReturnedObjectFromBoundary(node)
    );
  }
  if (
    node.key.type === AST_NODE_TYPES.PrivateIdentifier ||
    ("accessibility" in node &&
      (node.accessibility === "private" || node.accessibility === "protected"))
  ) {
    return false;
  }
  return enclosingClassExported(node);
}
function functionForImplementationParameter(parameter: ParserNode) {
  const maybeFunction = parameter.parent;
  return isParserFunction(maybeFunction) ? maybeFunction : null;
}
function isBoundaryObjectMethod(functionNode: ParserFunction) {
  const property = functionNode.parent;
  return (
    property.type === AST_NODE_TYPES.Property &&
    property.value === functionNode &&
    (enclosingObjectExported(property) ||
      enclosingReturnedObjectFromBoundary(property))
  );
}
function isExportedFunctionBoundary(functionNode: ParserFunction) {
  const owner = functionBoundaryNode(functionNode);
  if (
    owner.type === AST_NODE_TYPES.MethodDefinition &&
    !memberOfExportedClass(owner)
  ) {
    return false;
  }
  return isBoundary(owner);
}
function memberOfExportedClass(memberNode: ParserNode) {
  const classNode = memberNode.parent?.parent;
  return (
    enclosingClassExported(memberNode) ||
    (classNode?.type === AST_NODE_TYPES.ClassDeclaration &&
      isExported(classNode))
  );
}
export function inlineStructuralTypeAtBoundary(node: ParserNode) {
  const parent = node.parent;
  const parameter = parent?.parent;
  if (parent?.type !== AST_NODE_TYPES.TSTypeAnnotation || !parameter) {
    return false;
  }
  const functionNode = functionForImplementationParameter(parameter);
  if (!functionNode) {
    return false;
  }
  if (functionReturnsJsx(functionNode)) {
    return false;
  }
  return (
    isBoundaryObjectMethod(functionNode) ||
    isExportedFunctionBoundary(functionNode)
  );
}
