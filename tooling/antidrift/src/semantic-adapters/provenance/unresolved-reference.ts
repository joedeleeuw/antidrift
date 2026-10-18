import ts from "typescript";

import { isErrorType } from "../kernel/typescript-internals.ts";

export type UnresolvedFinding = {
  readonly kind: "module" | "shorthandModule" | "name";
  readonly name: string;
};

const NAME_SLOT_PARENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.ImportAttribute,
  ts.SyntaxKind.JsxNamespacedName,
]);

export function isCompilerErrorType(type: ts.Type | undefined): boolean {
  return !type || isErrorType(type);
}

export function moduleSpecifierOf(node: ts.Node): ts.Node | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier ?? null;
  }
  if (ts.isExternalModuleReference(node)) {
    return node.expression;
  }
  if (ts.isImportTypeNode(node)) {
    return ts.isLiteralTypeNode(node.argument)
      ? node.argument.literal
      : node.argument;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return node.arguments[0] ?? null;
  }
  return null;
}

function isShorthandAmbientModule(moduleSymbol: ts.Symbol): boolean {
  const declarations = moduleSymbol.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        ts.isModuleDeclaration(declaration) &&
        ts.isStringLiteral(declaration.name) &&
        !declaration.body
    )
  );
}

export function unresolvedModuleFinding(
  typeChecker: ts.TypeChecker,
  importNode: ts.Node
): UnresolvedFinding | null {
  const specifier = moduleSpecifierOf(importNode);
  if (!specifier) {
    return null;
  }
  if (!ts.isStringLiteralLike(specifier)) {
    return { kind: "module", name: specifier.getText() };
  }
  const moduleSymbol = typeChecker.getSymbolAtLocation(specifier);
  if (!moduleSymbol) {
    return { kind: "module", name: specifier.text };
  }
  return isShorthandAmbientModule(moduleSymbol)
    ? { kind: "shorthandModule", name: specifier.text }
    : null;
}

function isNonReferenceNameSlot(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    NAME_SLOT_PARENT_KINDS.has(parent.kind) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
    (ts.isNamedTupleMember(parent) && parent.name === node) ||
    (ts.isTypePredicateNode(parent) && parent.parameterName === node)
  );
}

function propertyNameFinding(
  typeChecker: ts.TypeChecker,
  access: ts.PropertyAccessExpression
): UnresolvedFinding | null {
  if (
    (typeChecker.getTypeAtLocation(access.expression).flags &
      ts.TypeFlags.Any) !==
    0
  ) {
    return null;
  }
  return isCompilerErrorType(typeChecker.getTypeAtLocation(access))
    ? { kind: "name", name: access.getText() }
    : null;
}

function typeNameReference(node: ts.Identifier): ts.TypeReferenceNode | null {
  let current: ts.Node = node;
  while (ts.isQualifiedName(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  return ts.isTypeReferenceNode(parent) && parent.typeName === current
    ? parent
    : null;
}

function isConstAssertionType(typeReference: ts.TypeReferenceNode): boolean {
  return (
    ts.isIdentifier(typeReference.typeName) &&
    typeReference.typeName.text === "const" &&
    (ts.isAsExpression(typeReference.parent) ||
      ts.isTypeAssertionExpression(typeReference.parent))
  );
}

function isDeclaredSymbol(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol !== undefined &&
    ((symbol.declarations?.length ?? 0) > 0 ||
      (symbol.flags & ts.SymbolFlags.Alias) !== 0)
  );
}

function typeNameFinding(
  typeChecker: ts.TypeChecker,
  node: ts.Identifier,
  typeReference: ts.TypeReferenceNode
): UnresolvedFinding | null {
  if (
    isConstAssertionType(typeReference) ||
    !isCompilerErrorType(typeChecker.getTypeFromTypeNode(typeReference))
  ) {
    return null;
  }
  const parent = node.parent;
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return isDeclaredSymbol(typeChecker.getSymbolAtLocation(parent.left))
      ? { kind: "name", name: parent.getText() }
      : null;
  }
  return { kind: "name", name: node.text };
}

function aliasFinding(
  typeChecker: ts.TypeChecker,
  symbol: ts.Symbol
): UnresolvedFinding | null {
  for (const declaration of symbol.declarations ?? []) {
    const importNode = ts.findAncestor(
      declaration,
      (ancestor) =>
        ts.isImportDeclaration(ancestor) ||
        ts.isExportDeclaration(ancestor) ||
        ts.isImportEqualsDeclaration(ancestor)
    );
    const moduleFinding =
      importNode &&
      unresolvedModuleFinding(
        typeChecker,
        ts.isImportEqualsDeclaration(importNode)
          ? importNode.moduleReference
          : importNode
      );
    if (moduleFinding) {
      return moduleFinding;
    }
  }
  return (typeChecker.getAliasedSymbol(symbol).declarations?.length ?? 0) > 0
    ? null
    : { kind: "name", name: symbol.name };
}

export function identifierFinding(
  typeChecker: ts.TypeChecker,
  node: ts.Identifier
): UnresolvedFinding | null {
  if (isNonReferenceNameSlot(node)) {
    return null;
  }
  const symbol = typeChecker.getSymbolAtLocation(node);
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    return symbol ? null : propertyNameFinding(typeChecker, node.parent);
  }
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return aliasFinding(typeChecker, symbol);
  }
  if (isDeclaredSymbol(symbol)) {
    return null;
  }
  const typeReference = typeNameReference(node);
  if (typeReference) {
    return typeNameFinding(typeChecker, node, typeReference);
  }
  return !symbol && isCompilerErrorType(typeChecker.getTypeAtLocation(node))
    ? { kind: "name", name: node.text }
    : null;
}
