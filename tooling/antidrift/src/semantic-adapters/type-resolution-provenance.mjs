import ts from "typescript";

const reachByProgram = new WeakMap();

const CALLABLE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.IndexSignature,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConstructorType,
]);

const CLASS_LIKE_KINDS = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.InterfaceDeclaration,
]);

const VALUE_HOLDER_KINDS = new Set([
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ExportAssignment,
]);

const CONTEXT_PASS_THROUGH_KINDS = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.JsxExpression,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.JsxAttributes,
  ts.SyntaxKind.JsxSpreadAttribute,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.NonNullExpression,
]);

const NAME_SLOT_PARENT_KINDS = new Set([
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.ImportAttribute,
  ts.SyntaxKind.JsxNamespacedName,
]);

function isCompilerErrorType(type) {
  return !type || type.intrinsicName === "error";
}

function moduleSpecifierOf(node) {
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

function isShorthandAmbientModule(moduleSymbol) {
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

export function unresolvedModuleFinding(typeChecker, importNode) {
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

function isPropertyNameSlot(node) {
  return (
    ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
  );
}

function isNonReferenceNameSlot(node) {
  const parent = node.parent;
  return (
    NAME_SLOT_PARENT_KINDS.has(parent.kind) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
    (ts.isNamedTupleMember(parent) && parent.name === node) ||
    (ts.isTypePredicateNode(parent) && parent.parameterName === node)
  );
}

function propertyNameFinding(typeChecker, node) {
  const access = node.parent;
  if (
    typeChecker.getTypeAtLocation(access.expression).flags & ts.TypeFlags.Any
  ) {
    return null;
  }
  return isCompilerErrorType(typeChecker.getTypeAtLocation(access))
    ? { kind: "name", name: access.getText() }
    : null;
}

function typeNameReference(node) {
  let current = node;
  while (ts.isQualifiedName(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  return ts.isTypeReferenceNode(parent) && parent.typeName === current
    ? parent
    : null;
}

function isConstAssertionType(typeReference) {
  return (
    ts.isIdentifier(typeReference.typeName) &&
    typeReference.typeName.text === "const" &&
    (ts.isAsExpression(typeReference.parent) ||
      ts.isTypeAssertionExpression(typeReference.parent))
  );
}

function isDeclaredSymbol(symbol) {
  return Boolean(
    symbol &&
    ((symbol.declarations?.length ?? 0) > 0 ||
      symbol.flags & ts.SymbolFlags.Alias)
  );
}

function typeNameFinding(typeChecker, node, typeReference) {
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

function identifierFinding(typeChecker, node) {
  if (isNonReferenceNameSlot(node)) {
    return null;
  }
  const symbol = typeChecker.getSymbolAtLocation(node);
  if (isPropertyNameSlot(node)) {
    return symbol ? null : propertyNameFinding(typeChecker, node);
  }
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
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

function aliasFinding(typeChecker, symbol) {
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

function referencedSymbols(typeChecker, node) {
  if (!ts.isIdentifier(node)) {
    return [];
  }
  const parent = node.parent;
  const symbol =
    ts.isShorthandPropertyAssignment(parent) && parent.name === node
      ? typeChecker.getShorthandAssignmentValueSymbol(parent)
      : typeChecker.getSymbolAtLocation(node);
  if (!symbol) {
    return [];
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return [symbol, typeChecker.getAliasedSymbol(symbol)];
  }
  return [symbol];
}

function collectReturnedExpressions(body) {
  const returned = [];
  function visit(node) {
    if (CALLABLE_KINDS.has(node.kind) || CLASS_LIKE_KINDS.has(node.kind)) {
      return;
    }
    if (
      (ts.isReturnStatement(node) || ts.isYieldExpression(node)) &&
      node.expression
    ) {
      returned.push(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return returned;
}

function callableEdges(node) {
  const edges = [...(node.typeParameters ?? []), ...(node.parameters ?? [])];
  const returnType = node.type ?? ts.getJSDocReturnType(node);
  if (returnType) {
    return [...edges, returnType];
  }
  if (!node.body) {
    return edges;
  }
  return ts.isBlock(node.body)
    ? [...edges, ...collectReturnedExpressions(node.body)]
    : [...edges, node.body];
}

function classLikeEdges(node) {
  return [
    ...(node.typeParameters ?? []),
    ...(node.heritageClauses ?? []),
    ...node.members,
  ];
}

function isContextuallyTypedCallable(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    (CALLABLE_KINDS.has(node.kind) && ts.isObjectLiteralExpression(node.parent))
  );
}

function returnContextEdges(callable) {
  if (callable.type) {
    return [callable.type];
  }
  return contextualTypeEdges(callable);
}

function contextAt(contextNode, parent) {
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return [
      parent.expression,
      ...(parent.typeArguments ?? []),
      ...(parent.arguments ?? []).filter(
        (argument) => argument !== contextNode
      ),
    ];
  }
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
    return [parent.tagName, ...(parent.typeArguments ?? [])];
  }
  if (
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    return [parent.type];
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === contextNode &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return [parent.left];
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isParameter(parent)
  ) {
    return parent.type ? [parent.type] : [];
  }
  if (ts.isArrowFunction(parent)) {
    return returnContextEdges(parent);
  }
  if (ts.isReturnStatement(parent)) {
    const owner = ts.findAncestor(parent, (ancestor) =>
      CALLABLE_KINDS.has(ancestor.kind)
    );
    return owner ? returnContextEdges(owner) : [];
  }
  return null;
}

function contextualTypeEdges(callable) {
  if (!isContextuallyTypedCallable(callable)) {
    return [];
  }
  let contextNode = callable;
  while (contextNode.parent) {
    const parent = contextNode.parent;
    const edges = contextAt(contextNode, parent);
    if (edges) {
      return edges;
    }
    if (!CONTEXT_PASS_THROUGH_KINDS.has(parent.kind)) {
      return [];
    }
    contextNode = parent;
  }
  return [];
}

function parameterEdges(node) {
  const declaredType = node.type ?? ts.getJSDocType(node);
  if (declaredType) {
    return [declaredType];
  }
  return [node.initializer, ...contextualTypeEdges(node.parent)].filter(
    Boolean
  );
}

function variableEdges(node) {
  const declaredType = node.type ?? ts.getJSDocType(node);
  if (declaredType) {
    return [declaredType];
  }
  const statement = node.parent?.parent;
  const iterated =
    statement &&
    (ts.isForOfStatement(statement) || ts.isForInStatement(statement))
      ? statement.expression
      : null;
  return [node.initializer, iterated].filter(Boolean);
}

function valueHolderEdges(node) {
  return [
    ...(node.typeParameters ?? []),
    node.type ?? ts.getJSDocType(node),
    node.initializer,
    node.constraint,
    node.default,
    node.expression,
  ].filter(Boolean);
}

function declarationEdges(node) {
  if (CALLABLE_KINDS.has(node.kind)) {
    return callableEdges(node);
  }
  if (CLASS_LIKE_KINDS.has(node.kind)) {
    return classLikeEdges(node);
  }
  if (ts.isParameter(node)) {
    return parameterEdges(node);
  }
  if (ts.isVariableDeclaration(node)) {
    return variableEdges(node);
  }
  if (ts.isBindingElement(node)) {
    return [node.initializer, node.parent.parent].filter(Boolean);
  }
  if (VALUE_HOLDER_KINDS.has(node.kind)) {
    return valueHolderEdges(node);
  }
  if (ts.isEnumDeclaration(node)) {
    return node.members;
  }
  return null;
}

function symbolEdges(typeChecker, node) {
  const edges = [];
  for (const symbol of referencedSymbols(typeChecker, node)) {
    for (const declaration of symbol.declarations ?? []) {
      edges.push(declaration);
    }
  }
  return edges;
}

function callArgumentsMatter(typeChecker, call) {
  const calleeType = typeChecker.getTypeAtLocation(call.expression);
  const signatures = ts.isNewExpression(call)
    ? calleeType.getConstructSignatures()
    : calleeType.getCallSignatures();
  return (
    signatures.length !== 1 || (signatures[0].typeParameters?.length ?? 0) > 0
  );
}

function expressionEdges(typeChecker, node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return [node.type];
  }
  if (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
    !callArgumentsMatter(typeChecker, node)
  ) {
    return [node.expression, ...(node.typeArguments ?? [])];
  }
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

function provenanceEdges(program, typeChecker, node) {
  if (ts.isSourceFile(node) || ts.isModuleDeclaration(node)) {
    return [];
  }
  const declared = declarationEdges(node);
  if (declared) {
    return declared;
  }
  if (ts.isImportSpecifier(node) || ts.isImportClause(node)) {
    return [ts.findAncestor(node, ts.isImportDeclaration)].filter(Boolean);
  }
  if (
    ts.isNamespaceImport(node) ||
    ts.isExportSpecifier(node) ||
    ts.isNamespaceExport(node)
  ) {
    return [
      ts.findAncestor(
        node,
        (ancestor) =>
          ts.isImportDeclaration(ancestor) || ts.isExportDeclaration(ancestor)
      ),
    ].filter(Boolean);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return [node.moduleReference];
  }
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return [];
  }
  if (ts.isIdentifier(node)) {
    return symbolEdges(typeChecker, node).filter(
      (declaration) =>
        !program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    );
  }
  return expressionEdges(typeChecker, node);
}

function reachMemo(program) {
  let memo = reachByProgram.get(program);
  if (!memo) {
    memo = new Map();
    reachByProgram.set(program, memo);
  }
  return memo;
}

export function findUnresolvedProvenance(program, typeChecker, rootNodes) {
  const memo = reachMemo(program);
  const visited = new Set();
  const frames = [];

  function enter(node) {
    const known = memo.get(node);
    if (known === false || visited.has(node)) {
      return null;
    }
    if (known) {
      return known;
    }
    visited.add(node);
    const finding = moduleSpecifierOf(node)
      ? unresolvedModuleFinding(typeChecker, node)
      : ts.isIdentifier(node) && identifierFinding(typeChecker, node);
    if (finding) {
      memo.set(node, finding);
      return finding;
    }
    frames.push({
      node,
      edges: provenanceEdges(program, typeChecker, node),
      next: 0,
    });
    return null;
  }

  function settle(finding) {
    for (const frame of frames) {
      memo.set(frame.node, finding);
    }
    return finding;
  }

  for (const rootNode of rootNodes) {
    const rootFinding = enter(rootNode);
    if (rootFinding) {
      return settle(rootFinding);
    }
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next >= frame.edges.length) {
        frames.pop();
        continue;
      }
      const finding = enter(frame.edges[frame.next]);
      frame.next += 1;
      if (finding) {
        return settle(finding);
      }
    }
  }
  for (const node of visited) {
    memo.set(node, false);
  }
  return null;
}

export function typeContainsCompilerError(typeChecker, type, seen = new Set()) {
  if (isCompilerErrorType(type)) {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  const nestedTypes = [
    ...(type.types ?? []),
    ...(type.flags & ts.TypeFlags.Object &&
    type.objectFlags & ts.ObjectFlags.Reference
      ? typeChecker.getTypeArguments(type)
      : []),
    ...typeChecker.getIndexInfosOfType(type).map((signature) => signature.type),
  ];
  return nestedTypes.some((nested) =>
    typeContainsCompilerError(typeChecker, nested, seen)
  );
}
