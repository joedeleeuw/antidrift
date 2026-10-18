import ts from "typescript";

import {
  isTypeReference,
  memberTypes,
} from "../kernel/typescript-internals.ts";
import type { UnresolvedFinding } from "./unresolved-reference.ts";
import {
  identifierFinding,
  isCompilerErrorType,
  moduleSpecifierOf,
  unresolvedModuleFinding,
} from "./unresolved-reference.ts";

type CallableDeclaration = Exclude<
  ts.SignatureDeclaration,
  ts.JSDocFunctionType
>;

type ClassLikeDeclaration = ts.ClassLikeDeclaration | ts.InterfaceDeclaration;

type ValueHolderDeclaration =
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | ts.PropertyAssignment
  | ts.EnumMember
  | ts.TypeParameterDeclaration
  | ts.TypeAliasDeclaration
  | ts.ExportAssignment;

type ProvenanceGraph = {
  readonly program: ts.Program;
  readonly typeChecker: ts.TypeChecker;
};

type ProvenanceFrame = {
  readonly node: ts.Node;
  readonly edges: readonly ts.Node[];
  next: number;
};

const reachByProgram = new WeakMap<
  ts.Program,
  Map<ts.Node, UnresolvedFinding | false>
>();

const CALLABLE_KINDS = new Set<ts.SyntaxKind>([
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

const CLASS_LIKE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.InterfaceDeclaration,
]);

const VALUE_HOLDER_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ExportAssignment,
]);

const CONTEXT_PASS_THROUGH_KINDS = new Set<ts.SyntaxKind>([
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

function isCallableDeclaration(node: ts.Node): node is CallableDeclaration {
  return CALLABLE_KINDS.has(node.kind);
}

function isClassLikeDeclaration(node: ts.Node): node is ClassLikeDeclaration {
  return CLASS_LIKE_KINDS.has(node.kind);
}

function isValueHolderDeclaration(
  node: ts.Node
): node is ValueHolderDeclaration {
  return VALUE_HOLDER_KINDS.has(node.kind);
}

function presentNodes(nodes: readonly (ts.Node | undefined)[]): ts.Node[] {
  return nodes.filter((node) => node !== undefined);
}

function collectReturnedExpressions(body: ts.Block): ts.Expression[] {
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isCallableDeclaration(node) || isClassLikeDeclaration(node)) {
      return;
    }
    if (
      (ts.isReturnStatement(node) || ts.isYieldExpression(node)) &&
      node.expression
    ) {
      returned.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return returned;
}

function callableEdges(node: CallableDeclaration): ts.Node[] {
  const edges: ts.Node[] = [...(node.typeParameters ?? []), ...node.parameters];
  const returnType = node.type ?? ts.getJSDocReturnType(node);
  if (returnType) {
    return [...edges, returnType];
  }
  const body = "body" in node ? node.body : undefined;
  if (!body) {
    return edges;
  }
  return ts.isBlock(body)
    ? [...edges, ...collectReturnedExpressions(body)]
    : [...edges, body];
}

function classLikeEdges(node: ClassLikeDeclaration): ts.Node[] {
  return [
    ...(node.typeParameters ?? []),
    ...(node.heritageClauses ?? []),
    ...node.members,
  ];
}

function isContextuallyTypedCallable(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    (isCallableDeclaration(node) && ts.isObjectLiteralExpression(node.parent))
  );
}

function returnContextEdges(callable: CallableDeclaration): ts.Node[] {
  if (callable.type) {
    return [callable.type];
  }
  return contextualTypeEdges(callable);
}

function declaredContext(parent: ts.Node): ts.Node[] | null {
  if (
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    return [parent.type];
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isParameter(parent)
  ) {
    return parent.type ? [parent.type] : [];
  }
  return null;
}

function contextAt(contextNode: ts.Node, parent: ts.Node): ts.Node[] | null {
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
    ts.isBinaryExpression(parent) &&
    parent.right === contextNode &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return [parent.left];
  }
  if (ts.isArrowFunction(parent)) {
    return returnContextEdges(parent);
  }
  if (ts.isReturnStatement(parent)) {
    const owner = ts.findAncestor(parent, isCallableDeclaration);
    return owner ? returnContextEdges(owner) : [];
  }
  return declaredContext(parent);
}

function contextualTypeEdges(callable: ts.Node): ts.Node[] {
  if (!isContextuallyTypedCallable(callable)) {
    return [];
  }
  let contextNode = callable;
  while (!ts.isSourceFile(contextNode)) {
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

function parameterEdges(node: ts.ParameterDeclaration): ts.Node[] {
  const declaredType = node.type ?? ts.getJSDocType(node);
  if (declaredType) {
    return [declaredType];
  }
  return presentNodes([node.initializer, ...contextualTypeEdges(node.parent)]);
}

function variableEdges(node: ts.VariableDeclaration): ts.Node[] {
  const declaredType = node.type ?? ts.getJSDocType(node);
  if (declaredType) {
    return [declaredType];
  }
  const statement = node.parent.parent;
  const iterated =
    ts.isForOfStatement(statement) || ts.isForInStatement(statement)
      ? statement.expression
      : undefined;
  return presentNodes([node.initializer, iterated]);
}

function valueHolderEdges(node: ValueHolderDeclaration): ts.Node[] {
  const typeParameters =
    "typeParameters" in node ? (node.typeParameters ?? []) : [];
  const declaredType =
    ("type" in node ? node.type : undefined) ?? ts.getJSDocType(node);
  if (declaredType) {
    return [...typeParameters, declaredType];
  }
  return presentNodes([
    ...typeParameters,
    "initializer" in node ? node.initializer : undefined,
    "constraint" in node ? node.constraint : undefined,
    "default" in node ? node.default : undefined,
    "expression" in node ? node.expression : undefined,
  ]);
}

function declarationEdges(node: ts.Node): ts.Node[] | null {
  if (isCallableDeclaration(node)) {
    return callableEdges(node);
  }
  if (isClassLikeDeclaration(node)) {
    return classLikeEdges(node);
  }
  if (ts.isParameter(node)) {
    return parameterEdges(node);
  }
  if (ts.isVariableDeclaration(node)) {
    return variableEdges(node);
  }
  if (ts.isBindingElement(node)) {
    return presentNodes([node.initializer, node.parent.parent]);
  }
  if (isValueHolderDeclaration(node)) {
    return valueHolderEdges(node);
  }
  if (ts.isEnumDeclaration(node)) {
    return [...node.members];
  }
  return null;
}

function referencedSymbols(
  typeChecker: ts.TypeChecker,
  node: ts.Identifier
): ts.Symbol[] {
  const parent = node.parent;
  const symbol =
    ts.isShorthandPropertyAssignment(parent) && parent.name === node
      ? typeChecker.getShorthandAssignmentValueSymbol(parent)
      : typeChecker.getSymbolAtLocation(node);
  if (!symbol) {
    return [];
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return [symbol, typeChecker.getAliasedSymbol(symbol)];
  }
  return [symbol];
}

function callArgumentsMatter(
  typeChecker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression
): boolean {
  const calleeType = typeChecker.getTypeAtLocation(call.expression);
  const signatures = ts.isNewExpression(call)
    ? calleeType.getConstructSignatures()
    : calleeType.getCallSignatures();
  return (
    signatures.length !== 1 || (signatures[0]?.typeParameters?.length ?? 0) > 0
  );
}

function expressionEdges(
  typeChecker: ts.TypeChecker,
  node: ts.Node
): ts.Node[] {
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
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

function moduleEdges(node: ts.Node): ts.Node[] | null {
  if (ts.isImportSpecifier(node) || ts.isImportClause(node)) {
    return presentNodes([ts.findAncestor(node, ts.isImportDeclaration)]);
  }
  if (
    ts.isNamespaceImport(node) ||
    ts.isExportSpecifier(node) ||
    ts.isNamespaceExport(node)
  ) {
    return presentNodes([
      ts.findAncestor(
        node,
        (ancestor) =>
          ts.isImportDeclaration(ancestor) || ts.isExportDeclaration(ancestor)
      ),
    ]);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return [node.moduleReference];
  }
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return [];
  }
  return null;
}

function provenanceEdges(graph: ProvenanceGraph, node: ts.Node): ts.Node[] {
  if (ts.isSourceFile(node) || ts.isModuleDeclaration(node)) {
    return [];
  }
  const declared = declarationEdges(node) ?? moduleEdges(node);
  if (declared) {
    return declared;
  }
  if (ts.isIdentifier(node)) {
    return referencedSymbols(graph.typeChecker, node)
      .flatMap((symbol) => symbol.declarations ?? [])
      .filter(
        (declaration) =>
          !graph.program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      );
  }
  return expressionEdges(graph.typeChecker, node);
}

function reachMemo(
  program: ts.Program
): Map<ts.Node, UnresolvedFinding | false> {
  const memo =
    reachByProgram.get(program) ??
    new Map<ts.Node, UnresolvedFinding | false>();
  reachByProgram.set(program, memo);
  return memo;
}

function nodeFinding(
  typeChecker: ts.TypeChecker,
  node: ts.Node
): UnresolvedFinding | null {
  if (moduleSpecifierOf(node)) {
    return unresolvedModuleFinding(typeChecker, node);
  }
  return ts.isIdentifier(node) ? identifierFinding(typeChecker, node) : null;
}

export function findUnresolvedProvenance(
  program: ts.Program,
  typeChecker: ts.TypeChecker,
  rootNodes: readonly ts.Node[]
): UnresolvedFinding | null {
  const graph = { program, typeChecker };
  const memo = reachMemo(program);
  const visited = new Set<ts.Node>();
  const frames: ProvenanceFrame[] = [];
  const enter = (node: ts.Node): UnresolvedFinding | null => {
    const known = memo.get(node);
    if (known === false || visited.has(node)) {
      return null;
    }
    if (known) {
      return known;
    }
    visited.add(node);
    const finding = nodeFinding(typeChecker, node);
    if (finding) {
      memo.set(node, finding);
      return finding;
    }
    frames.push({ node, edges: provenanceEdges(graph, node), next: 0 });
    return null;
  };
  const settle = (finding: UnresolvedFinding): UnresolvedFinding => {
    for (const frame of frames) {
      memo.set(frame.node, finding);
    }
    return finding;
  };
  for (const rootNode of rootNodes) {
    const rootFinding = enter(rootNode);
    if (rootFinding) {
      return settle(rootFinding);
    }
    for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
      const edge = frame.edges[frame.next];
      if (edge === undefined) {
        frames.pop();
        continue;
      }
      frame.next += 1;
      const finding = enter(edge);
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

function nestedTypes(typeChecker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  const typeArguments =
    (type.flags & ts.TypeFlags.Object) !== 0 && isTypeReference(type)
      ? typeChecker.getTypeArguments(type)
      : [];
  return [
    ...memberTypes(type),
    ...typeArguments,
    ...typeChecker.getIndexInfosOfType(type).map((signature) => signature.type),
  ];
}

export function typeContainsCompilerError(
  typeChecker: ts.TypeChecker,
  type: ts.Type | undefined,
  seen = new Set<ts.Type>()
): boolean {
  if (isCompilerErrorType(type) || !type) {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  return nestedTypes(typeChecker, type).some((nested) =>
    typeContainsCompilerError(typeChecker, nested, seen)
  );
}
