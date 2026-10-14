import ts from "typescript";
import { isAppeasementCastSourceType } from "./broad-input.mjs";
import { isEffectSchemaMethod } from "./effect-schema.mjs";
import { ZOD_PARSE_METHODS, isZodMethod } from "./schema-provenance.mjs";

const TYPE_FLAG_ANY = 1;
const TYPE_FLAG_UNKNOWN = 2;
const MAX_PROVENANCE_DEPTH = 16;

const EFFECT_VALUE_DECODE_METHODS = new Set([
  "decode",
  "decodeSync",
  "decodePromise",
  "decodeUnknown",
  "decodeUnknownSync",
  "decodeUnknownPromise",
]);

const YUP_VALIDATE_METHODS = new Set(["validate", "validateSync", "cast"]);
const ZOD_SAFE_PARSE_METHODS = new Set(["safeParse", "safeParseAsync"]);

function expressionRoot(expression) {
  let currentExpression = expression;
  while (currentExpression) {
    if (
      ts.isParenthesizedExpression(currentExpression) ||
      ts.isAsExpression(currentExpression) ||
      ts.isNonNullExpression(currentExpression) ||
      ts.isTypeAssertionExpression(currentExpression)
    ) {
      currentExpression = currentExpression.expression;
      continue;
    }
    break;
  }
  return currentExpression;
}

function sameReference(typeChecker, leftExpression, rightExpression) {
  const cleanLeft = expressionRoot(leftExpression);
  const cleanRight = expressionRoot(rightExpression);
  if (!cleanLeft || !cleanRight) {
    return false;
  }
  if (ts.isIdentifier(cleanLeft) && ts.isIdentifier(cleanRight)) {
    const leftSymbol = typeChecker.getSymbolAtLocation(cleanLeft);
    const rightSymbol = typeChecker.getSymbolAtLocation(cleanRight);
    return Boolean(leftSymbol && leftSymbol === rightSymbol);
  }
  if (
    ts.isPropertyAccessExpression(cleanLeft) &&
    ts.isPropertyAccessExpression(cleanRight) &&
    cleanLeft.name.text === cleanRight.name.text
  ) {
    return sameReference(
      typeChecker,
      cleanLeft.expression,
      cleanRight.expression
    );
  }
  if (
    ts.isElementAccessExpression(cleanLeft) &&
    ts.isElementAccessExpression(cleanRight) &&
    ts.isStringLiteral(cleanLeft.argumentExpression) &&
    ts.isStringLiteral(cleanRight.argumentExpression) &&
    cleanLeft.argumentExpression.text === cleanRight.argumentExpression.text
  ) {
    return sameReference(
      typeChecker,
      cleanLeft.expression,
      cleanRight.expression
    );
  }
  return false;
}

function changesOperand(typeChecker, statementOrExpression, operandExpression) {
  if (
    ts.isBinaryExpression(statementOrExpression) &&
    statementOrExpression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    statementOrExpression.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    sameReference(typeChecker, statementOrExpression.left, operandExpression)
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(statementOrExpression) ||
      ts.isPostfixUnaryExpression(statementOrExpression)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
      statementOrExpression.operator
    ) &&
    sameReference(typeChecker, statementOrExpression.operand, operandExpression)
  ) {
    return true;
  }
  return (
    ts.forEachChild(statementOrExpression, (childNode) =>
      changesOperand(typeChecker, childNode, operandExpression)
    ) === true
  );
}

function statementAlwaysExits(statementNode) {
  if (!statementNode) {
    return false;
  }
  if (
    ts.isReturnStatement(statementNode) ||
    ts.isThrowStatement(statementNode) ||
    ts.isBreakStatement(statementNode) ||
    ts.isContinueStatement(statementNode)
  ) {
    return true;
  }
  if (ts.isBlock(statementNode) && statementNode.statements.length > 0) {
    return statementAlwaysExits(
      statementNode.statements[statementNode.statements.length - 1]
    );
  }
  return false;
}

function isExternalOrLibraryFile(program, sourceFile) {
  if (!sourceFile) {
    return true;
  }
  const normalizedPath = sourceFile.fileName.replace(/\\/gu, "/");
  return (
    normalizedPath.includes("/node_modules/") ||
    Boolean(program?.isSourceFileDefaultLibrary?.(sourceFile))
  );
}

function isCompilerErrorType(typeChecker, type) {
  if (!type) {
    return true;
  }
  return (
    type.intrinsicName === "error" ||
    Boolean(typeChecker.isErrorType && typeChecker.isErrorType(type))
  );
}

function isModuleSpecifierResolved(program, typeChecker, specifierNode) {
  if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) {
    return true;
  }
  const sourceFile = specifierNode.getSourceFile();
  const programResolved = program?.getResolvedModuleFromModuleSpecifier?.(
    specifierNode,
    sourceFile
  );
  if (programResolved?.resolvedModule) {
    return true;
  }
  const compilerOptions = {
    ...program?.getCompilerOptions?.(),
    traceResolution: false,
  };
  const fallbackResolved = ts.resolveModuleName(
    specifierNode.text,
    sourceFile.fileName,
    compilerOptions,
    ts.sys
  );
  if (fallbackResolved?.resolvedModule) {
    return true;
  }
  const moduleSymbol = typeChecker.getSymbolAtLocation(specifierNode);
  if ((moduleSymbol?.declarations?.length ?? 0) > 0) {
    return true;
  }
  return Boolean(typeChecker.tryFindAmbientModule?.(specifierNode.text));
}

function enclosingImportModuleSpecifier(node) {
  let parentNode = node.parent;
  while (parentNode && !ts.isImportDeclaration(parentNode)) {
    parentNode = parentNode.parent;
  }
  const specifier = parentNode?.moduleSpecifier;
  return specifier && ts.isStringLiteralLike(specifier) ? specifier : null;
}

function directNodeModuleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    return specifier && ts.isStringLiteralLike(specifier) ? specifier : null;
  }
  if (
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node)
  ) {
    return enclosingImportModuleSpecifier(node);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    const expr = node.moduleReference.expression;
    return expr && ts.isStringLiteralLike(expr) ? expr : null;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    const isDynamicImport =
      node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequireCall =
      ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (
      (isDynamicImport || isRequireCall) &&
      ts.isStringLiteralLike(firstArg)
    ) {
      return firstArg;
    }
  }
  return null;
}

function isConstAssertionTypeNode(node) {
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === "const"
  );
}

function isResolvedCheckerSymbol(typeChecker, symbol) {
  if (!symbol) {
    return false;
  }
  if ((symbol.declarations?.length ?? 0) > 0) {
    return true;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliasedSymbol = typeChecker.getAliasedSymbol(symbol);
    return (aliasedSymbol?.declarations?.length ?? 0) > 0;
  }
  return false;
}

function entityNameRootIdentifier(entityName) {
  let current = entityName;
  while (current && ts.isQualifiedName(current)) {
    current = current.left;
  }
  return current && ts.isIdentifier(current) ? current : null;
}

function isPartOfTypeEntityName(node) {
  let current = node;
  while (current?.parent && ts.isQualifiedName(current.parent)) {
    current = current.parent;
  }
  return Boolean(
    current?.parent &&
    (ts.isTypeReferenceNode(current.parent) ||
      ts.isTypeQueryNode(current.parent))
  );
}

function unresolvedDirectNodeReference(typeChecker, node) {
  if (ts.isTypeReferenceNode(node) && !isConstAssertionTypeNode(node)) {
    const symbol = typeChecker.getSymbolAtLocation(node.typeName);
    if (
      !isResolvedCheckerSymbol(typeChecker, symbol) &&
      isCompilerErrorType(typeChecker, typeChecker.getTypeFromTypeNode(node))
    ) {
      return { kind: "type", name: node.typeName.getText() };
    }
  }
  if (ts.isTypeQueryNode(node)) {
    if (
      isCompilerErrorType(typeChecker, typeChecker.getTypeFromTypeNode(node))
    ) {
      return { kind: "value", name: node.exprName.getText() };
    }
  }
  if (
    ts.isIdentifier(node) &&
    node.text !== "undefined" &&
    !isPartOfTypeEntityName(node)
  ) {
    const parentNode = node.parent;
    const isMemberName =
      parentNode &&
      ts.isPropertyAccessExpression(parentNode) &&
      parentNode.name === node;
    if (
      !isMemberName &&
      !typeChecker.getSymbolAtLocation(node) &&
      isCompilerErrorType(typeChecker, typeChecker.getTypeAtLocation(node))
    ) {
      return { kind: "value", name: node.text };
    }
  }
  return null;
}

const IMPORT_DECLARATION_KINDS = new Set([
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
]);

const BINDING_CHAIN_KINDS = new Set([
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.ObjectBindingPattern,
  ts.SyntaxKind.ArrayBindingPattern,
]);

const TYPED_INITIALIZER_DECLARATION_KINDS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
]);

const CALLABLE_DECLARATION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.GetAccessorDeclaration,
]);

function collectBindingElementTargets(bindingElement) {
  const targets = [];
  let current = bindingElement;
  while (current && BINDING_CHAIN_KINDS.has(current.kind)) {
    if (current.initializer) {
      targets.push(current.initializer);
    }
    current = current.parent;
  }
  if (
    current &&
    (ts.isVariableDeclaration(current) || ts.isParameter(current))
  ) {
    return [...targets, ...[current.type, current.initializer].filter(Boolean)];
  }
  return targets;
}

function collectDeclarationFollowTargets(declarationNode) {
  if (IMPORT_DECLARATION_KINDS.has(declarationNode.kind)) {
    return [declarationNode];
  }
  if (ts.isBindingElement(declarationNode)) {
    return collectBindingElementTargets(declarationNode);
  }
  if (TYPED_INITIALIZER_DECLARATION_KINDS.has(declarationNode.kind)) {
    return [declarationNode.type, declarationNode.initializer].filter(Boolean);
  }
  if (CALLABLE_DECLARATION_KINDS.has(declarationNode.kind)) {
    if (declarationNode.type) {
      return [declarationNode.type];
    }
    return declarationNode.body && !ts.isBlock(declarationNode.body)
      ? [declarationNode.body]
      : [];
  }
  if (ts.isTypeAliasDeclaration(declarationNode)) {
    return [declarationNode.type];
  }
  if (
    ts.isInterfaceDeclaration(declarationNode) ||
    ts.isClassDeclaration(declarationNode)
  ) {
    return [
      ...(declarationNode.heritageClauses ?? []),
      ...(declarationNode.members ?? []),
    ];
  }
  return [];
}

function collectLookupTargetNodes(node) {
  if (ts.isTypeReferenceNode(node)) {
    return [entityNameRootIdentifier(node.typeName), node.typeName].filter(
      Boolean
    );
  }
  if (ts.isTypeQueryNode(node)) {
    return [entityNameRootIdentifier(node.exprName), node.exprName].filter(
      Boolean
    );
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return [node];
  }
  return [];
}

function lookupNodeSymbols(typeChecker, node) {
  const symbols = [];
  for (const targetNode of collectLookupTargetNodes(node)) {
    const primarySymbol = typeChecker.getSymbolAtLocation(targetNode);
    if (!primarySymbol) {
      continue;
    }
    symbols.push(primarySymbol);
    if (primarySymbol.flags & ts.SymbolFlags.Alias) {
      const aliasedSymbol = typeChecker.getAliasedSymbol(primarySymbol);
      if (aliasedSymbol && aliasedSymbol !== primarySymbol) {
        symbols.push(aliasedSymbol);
      }
    }
  }
  return symbols;
}

function findNodeUnresolvedProvenance(program, typeChecker, rootNode) {
  if (!rootNode) {
    return null;
  }
  const visitedNodes = new Set();
  const visitedSymbols = new Set();

  function walk(node, depth) {
    if (
      !node ||
      depth > MAX_PROVENANCE_DEPTH ||
      visitedNodes.has(node) ||
      isConstAssertionTypeNode(node)
    ) {
      return null;
    }
    visitedNodes.add(node);
    if (isExternalOrLibraryFile(program, node.getSourceFile?.())) {
      return null;
    }
    const specifier = directNodeModuleSpecifier(node);
    if (
      specifier &&
      !isModuleSpecifierResolved(program, typeChecker, specifier)
    ) {
      return { kind: "module", name: specifier.text };
    }
    for (const symbol of lookupNodeSymbols(typeChecker, node)) {
      if (visitedSymbols.has(symbol)) {
        continue;
      }
      visitedSymbols.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (isExternalOrLibraryFile(program, declaration.getSourceFile?.())) {
          continue;
        }
        for (const followTarget of collectDeclarationFollowTargets(
          declaration
        )) {
          const hit = walk(followTarget, depth + 1);
          if (hit) {
            return hit;
          }
        }
      }
    }
    const directUnresolved = unresolvedDirectNodeReference(typeChecker, node);
    if (directUnresolved) {
      return directUnresolved;
    }
    let childHit = null;
    ts.forEachChild(node, (childNode) => {
      if (!childHit) {
        childHit = walk(childNode, depth + 1);
      }
    });
    return childHit;
  }

  return walk(rootNode, 0);
}

function typeContainsCompilerError(typeChecker, type, seen = new Set()) {
  if (!type) {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);
  if (isCompilerErrorType(typeChecker, type)) {
    return true;
  }
  if (
    (type.types ?? []).some((constituent) =>
      typeContainsCompilerError(typeChecker, constituent, seen)
    )
  ) {
    return true;
  }
  if (
    (typeChecker.getTypeArguments?.(type) ?? []).some((argumentType) =>
      typeContainsCompilerError(typeChecker, argumentType, seen)
    )
  ) {
    return true;
  }
  const stringIndexType = type.getStringIndexType?.();
  if (
    stringIndexType &&
    typeContainsCompilerError(typeChecker, stringIndexType, seen)
  ) {
    return true;
  }
  const numberIndexType = type.getNumberIndexType?.();
  return Boolean(
    numberIndexType &&
    typeContainsCompilerError(typeChecker, numberIndexType, seen)
  );
}

function findCastUnresolvedProvenance(
  program,
  typeChecker,
  tsExpression,
  tsTypeNode,
  sourceType,
  targetType
) {
  if (!tsExpression || !tsTypeNode) {
    return { kind: "type", name: null };
  }
  const expressionUnresolved = findNodeUnresolvedProvenance(
    program,
    typeChecker,
    tsExpression
  );
  if (expressionUnresolved) {
    return expressionUnresolved;
  }
  if (!isConstAssertionTypeNode(tsTypeNode)) {
    const targetUnresolved = findNodeUnresolvedProvenance(
      program,
      typeChecker,
      tsTypeNode
    );
    if (targetUnresolved) {
      return targetUnresolved;
    }
  }
  if (
    typeContainsCompilerError(typeChecker, sourceType) ||
    typeContainsCompilerError(typeChecker, targetType)
  ) {
    return { kind: "type", name: null };
  }
  return null;
}

function formatIncompleteAnalysisMessage(unresolved) {
  if (unresolved?.kind === "module" && unresolved.name) {
    return `Incomplete analysis: TypeScript could not resolve module '${unresolved.name}' for this cast.`;
  }
  if (unresolved?.name) {
    return `Incomplete analysis: TypeScript could not resolve '${unresolved.name}' for this cast.`;
  }
  return "Incomplete analysis: TypeScript could not resolve the types for this cast.";
}

function isBroadArrayPredicateType(typeChecker, predicateType, targetType) {
  if (!typeChecker.isArrayType(predicateType)) {
    return false;
  }
  const predicateElementType = typeChecker.getTypeArguments(predicateType)[0];
  if (!predicateElementType || !(predicateElementType.flags & TYPE_FLAG_ANY)) {
    return false;
  }
  if (!typeChecker.isArrayType(targetType)) {
    return true;
  }
  const targetElementType = typeChecker.getTypeArguments(targetType)[0];
  return Boolean(
    targetElementType &&
    !(targetElementType.flags & (TYPE_FLAG_ANY | TYPE_FLAG_UNKNOWN))
  );
}

function isPredicateAssignableToTarget(typeChecker, predicateType, targetType) {
  if (
    !predicateType ||
    predicateType.flags & (TYPE_FLAG_ANY | TYPE_FLAG_UNKNOWN)
  ) {
    return false;
  }
  if (isBroadArrayPredicateType(typeChecker, predicateType, targetType)) {
    return false;
  }
  return typeChecker.isTypeAssignableTo(predicateType, targetType);
}

function isExpectationInstanceCheck(castContext, callExpression) {
  const { typeChecker, tsExpression, targetType } = castContext;
  if (
    !ts.isCallExpression(callExpression) ||
    !ts.isPropertyAccessExpression(callExpression.expression)
  ) {
    return false;
  }
  const memberAccess = callExpression.expression;
  const expectationCall = memberAccess.expression;
  if (
    memberAccess.name.text !== "toBeInstanceOf" ||
    !ts.isCallExpression(expectationCall) ||
    !ts.isIdentifier(expectationCall.expression) ||
    expectationCall.arguments.length !== 1 ||
    !sameReference(typeChecker, expectationCall.arguments[0], tsExpression)
  ) {
    return false;
  }
  const constructorArgument = callExpression.arguments[0];
  if (!constructorArgument) {
    return false;
  }
  const constructorType = typeChecker.getTypeAtLocation(constructorArgument);
  return constructorType.getConstructSignatures().some((signature) => {
    const returnType = typeChecker.getReturnTypeOfSignature(signature);
    return typeChecker.isTypeAssignableTo(returnType, targetType);
  });
}

function hasBooleanTypePredicateSignature(castContext, callExpression) {
  const { typeChecker, tsExpression, targetType } = castContext;
  const signature = typeChecker.getResolvedSignature(callExpression);
  const typePredicate =
    signature && typeChecker.getTypePredicateOfSignature(signature);
  if (
    !typePredicate ||
    !typePredicate.type ||
    (typePredicate.kind !== ts.TypePredicateKind.Identifier &&
      typePredicate.kind !== ts.TypePredicateKind.This)
  ) {
    return false;
  }
  const argumentForPredicate =
    callExpression.arguments[typePredicate.parameterIndex];
  return Boolean(
    argumentForPredicate &&
    sameReference(typeChecker, argumentForPredicate, tsExpression) &&
    isPredicateAssignableToTarget(typeChecker, typePredicate.type, targetType)
  );
}

function isAssertsCallProof(castContext, callExpression) {
  if (!ts.isCallExpression(callExpression)) {
    return false;
  }
  const { typeChecker, tsExpression, targetType } = castContext;
  const signature = typeChecker.getResolvedSignature(callExpression);
  const typePredicate =
    signature && typeChecker.getTypePredicateOfSignature(signature);
  if (
    typePredicate &&
    (typePredicate.kind === ts.TypePredicateKind.AssertsIdentifier ||
      typePredicate.kind === ts.TypePredicateKind.AssertsThis)
  ) {
    const argumentForPredicate =
      callExpression.arguments[typePredicate.parameterIndex];
    if (!argumentForPredicate) {
      return false;
    }
    if (typePredicate.type) {
      return (
        sameReference(typeChecker, argumentForPredicate, tsExpression) &&
        isPredicateAssignableToTarget(
          typeChecker,
          typePredicate.type,
          targetType
        )
      );
    }
    return conditionProvesTarget(castContext, argumentForPredicate, false);
  }
  if (
    ts.isIdentifier(callExpression.expression) &&
    ["assert", "invariant", "ok"].includes(callExpression.expression.text) &&
    callExpression.arguments.length >= 1
  ) {
    return conditionProvesTarget(
      castContext,
      callExpression.arguments[0],
      false
    );
  }
  return false;
}

function isDefaultLibraryCollectionHas(program, typeChecker, methodNameNode) {
  const symbol = typeChecker.getSymbolAtLocation(methodNameNode);
  return (symbol?.declarations ?? []).some((declaration) =>
    Boolean(program?.isSourceFileDefaultLibrary?.(declaration.getSourceFile()))
  );
}

function callConditionProvesTarget(castContext, callExpression) {
  if (hasBooleanTypePredicateSignature(castContext, callExpression)) {
    return true;
  }
  const { program, typeChecker, tsExpression, targetType } = castContext;
  if (
    ts.isPropertyAccessExpression(callExpression.expression) &&
    callExpression.expression.name.text === "has" &&
    callExpression.arguments.length === 1 &&
    isDefaultLibraryCollectionHas(
      program,
      typeChecker,
      callExpression.expression.name
    ) &&
    sameReference(typeChecker, callExpression.arguments[0], tsExpression)
  ) {
    const signatureHas = typeChecker.getResolvedSignature(callExpression);
    const firstParameter = signatureHas?.parameters[0];
    if (firstParameter) {
      const parameterType = typeChecker.getTypeOfSymbolAtLocation(
        firstParameter,
        callExpression
      );
      return (
        !(parameterType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        typeChecker.isTypeAssignableTo(parameterType, targetType)
      );
    }
  }
  return false;
}

function instanceOfConditionProvesTarget(castContext, binaryExpression) {
  const { typeChecker, tsExpression, targetType } = castContext;
  if (
    binaryExpression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    sameReference(typeChecker, binaryExpression.left, tsExpression)
  ) {
    const constructorType = typeChecker.getTypeAtLocation(
      binaryExpression.right
    );
    return constructorType.getConstructSignatures().some((signature) => {
      const returnType = typeChecker.getReturnTypeOfSignature(signature);
      return typeChecker.isTypeAssignableTo(returnType, targetType);
    });
  }
  return false;
}

function isYupMethod(typeChecker, tsNameNode) {
  const rawSymbol = tsNameNode && typeChecker.getSymbolAtLocation(tsNameNode);
  const symbol =
    rawSymbol && rawSymbol.flags & ts.SymbolFlags.Alias
      ? typeChecker.getAliasedSymbol(rawSymbol)
      : rawSymbol;
  for (const declaration of symbol?.declarations ?? []) {
    const filePath = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    const markerIndex = filePath.lastIndexOf("/node_modules/");
    if (markerIndex === -1) {
      continue;
    }
    const packagePath = filePath.slice(markerIndex + "/node_modules/".length);
    if (
      packagePath === "yup" ||
      packagePath.startsWith("yup/") ||
      packagePath.startsWith("@types/yup/")
    ) {
      return true;
    }
  }
  return false;
}

function isBrandKitMethod(typeChecker, tsNameNode, expectedMethodName) {
  if (!tsNameNode || tsNameNode.text !== expectedMethodName) {
    return false;
  }
  const rawSymbol = typeChecker.getSymbolAtLocation(tsNameNode);
  const symbol =
    rawSymbol && rawSymbol.flags & ts.SymbolFlags.Alias
      ? typeChecker.getAliasedSymbol(rawSymbol)
      : rawSymbol;
  for (const declaration of symbol?.declarations ?? []) {
    const filePath = declaration.getSourceFile().fileName.replace(/\\/gu, "/");
    if (
      filePath.endsWith("@joedeleeuw/antidrift/src/brand/index.d.mts") ||
      filePath.endsWith("tooling/antidrift/src/brand/index.d.mts")
    ) {
      return true;
    }
  }
  return false;
}

function isRecognisedLibraryDecoderCall(typeChecker, callExpression) {
  const callee = callExpression.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text;
    if (
      ZOD_PARSE_METHODS.has(methodName) &&
      isZodMethod(typeChecker, callee.name)
    ) {
      return true;
    }
    if (
      YUP_VALIDATE_METHODS.has(methodName) &&
      isYupMethod(typeChecker, callee.name)
    ) {
      return true;
    }
    if (
      EFFECT_VALUE_DECODE_METHODS.has(methodName) &&
      isEffectSchemaMethod(typeChecker, callee.name)
    ) {
      return true;
    }
    if (isBrandKitMethod(typeChecker, callee.name, "make")) {
      return true;
    }
  }
  if (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression)
  ) {
    const innerMethod = callee.expression.name;
    if (
      EFFECT_VALUE_DECODE_METHODS.has(innerMethod.text) &&
      isEffectSchemaMethod(typeChecker, innerMethod)
    ) {
      return true;
    }
  }
  return false;
}

function isCallReturningDecodedTarget(
  typeChecker,
  candidateExpression,
  targetType
) {
  let unwrapped = expressionRoot(candidateExpression);
  let wasAwaited = false;
  if (unwrapped && ts.isAwaitExpression(unwrapped)) {
    wasAwaited = true;
    unwrapped = expressionRoot(unwrapped.expression);
  }
  if (!unwrapped || !ts.isCallExpression(unwrapped)) {
    return false;
  }
  if (!isRecognisedLibraryDecoderCall(typeChecker, unwrapped)) {
    return false;
  }
  const signature = typeChecker.getResolvedSignature(unwrapped);
  if (!signature) {
    return false;
  }
  let outputType = typeChecker.getReturnTypeOfSignature(signature);
  if (wasAwaited && typeChecker.getAwaitedType) {
    outputType = typeChecker.getAwaitedType(outputType) ?? outputType;
  }
  if (
    !outputType ||
    outputType.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)
  ) {
    return false;
  }
  return typeChecker.isTypeAssignableTo(outputType, targetType);
}

function resolveSingleInitializerExpression(typeChecker, expressionNode) {
  const unwrapped = expressionRoot(expressionNode);
  if (!unwrapped || !ts.isIdentifier(unwrapped)) {
    return null;
  }
  const symbol = typeChecker.getSymbolAtLocation(unwrapped);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
  }
  return null;
}

function isRecognisedSafeWrapperResult(
  typeChecker,
  wrapperExpression,
  propertyName,
  targetType
) {
  let callNode = expressionRoot(wrapperExpression);
  const initExpr = resolveSingleInitializerExpression(typeChecker, callNode);
  if (initExpr) {
    callNode = expressionRoot(initExpr);
  }
  let wasAwaited = false;
  if (callNode && ts.isAwaitExpression(callNode)) {
    wasAwaited = true;
    callNode = expressionRoot(callNode.expression);
  }
  if (
    !callNode ||
    !ts.isCallExpression(callNode) ||
    !ts.isPropertyAccessExpression(callNode.expression)
  ) {
    return false;
  }
  const methodNode = callNode.expression.name;
  const isZodSafe =
    propertyName === "data" &&
    ZOD_SAFE_PARSE_METHODS.has(methodNode.text) &&
    isZodMethod(typeChecker, methodNode);
  const isBrandSafe =
    propertyName === "value" &&
    isBrandKitMethod(typeChecker, methodNode, "safe");
  if (!isZodSafe && !isBrandSafe) {
    return false;
  }
  const signature = typeChecker.getResolvedSignature(callNode);
  if (!signature) {
    return false;
  }
  let wrapperType = typeChecker.getReturnTypeOfSignature(signature);
  if (wasAwaited && typeChecker.getAwaitedType) {
    wrapperType = typeChecker.getAwaitedType(wrapperType) ?? wrapperType;
  }
  const variants = wrapperType?.types ?? [wrapperType];
  for (const variant of variants) {
    const propSym =
      variant && typeChecker.getPropertyOfType(variant, propertyName);
    if (!propSym) {
      continue;
    }
    const propType = typeChecker.getTypeOfSymbolAtLocation(propSym, callNode);
    const nonNullPropType = typeChecker.getNonNullableType(propType);
    if (
      nonNullPropType &&
      !(nonNullPropType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
      typeChecker.isTypeAssignableTo(nonNullPropType, targetType)
    ) {
      return true;
    }
  }
  return false;
}

function safeWrapperAccessTarget(typeChecker, operandExpression) {
  let cleanOperand = expressionRoot(operandExpression);
  const initExpr = resolveSingleInitializerExpression(
    typeChecker,
    cleanOperand
  );
  if (initExpr) {
    cleanOperand = expressionRoot(initExpr);
  }
  if (!cleanOperand || !ts.isPropertyAccessExpression(cleanOperand)) {
    return null;
  }
  const propName = cleanOperand.name.text;
  if (propName !== "data" && propName !== "value") {
    return null;
  }
  return {
    wrapperObject: cleanOperand.expression,
    valueProperty: propName,
    flagProperty: propName === "data" ? "success" : "ok",
  };
}

function isSafeWrapperFlagCondition(castContext, conditionNode) {
  if (!ts.isPropertyAccessExpression(conditionNode)) {
    return false;
  }
  const { typeChecker, tsExpression, targetType } = castContext;
  const accessTarget = safeWrapperAccessTarget(typeChecker, tsExpression);
  if (
    !accessTarget ||
    conditionNode.name.text !== accessTarget.flagProperty ||
    !sameReference(
      typeChecker,
      conditionNode.expression,
      accessTarget.wrapperObject
    )
  ) {
    return false;
  }
  return isRecognisedSafeWrapperResult(
    typeChecker,
    accessTarget.wrapperObject,
    accessTarget.valueProperty,
    targetType
  );
}

function isDecodedValueCast(castContext) {
  const { typeChecker, tsExpression, targetType } = castContext;
  if (isCallReturningDecodedTarget(typeChecker, tsExpression, targetType)) {
    return true;
  }
  const initializer = resolveSingleInitializerExpression(
    typeChecker,
    tsExpression
  );
  return Boolean(
    initializer &&
    isCallReturningDecodedTarget(typeChecker, initializer, targetType)
  );
}

function conditionProvesTarget(castContext, conditionExpression, negated) {
  const unwrappedCondition = expressionRoot(conditionExpression);
  if (!unwrappedCondition) {
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(unwrappedCondition) &&
    unwrappedCondition.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return conditionProvesTarget(
      castContext,
      unwrappedCondition.operand,
      !negated
    );
  }
  if (ts.isBinaryExpression(unwrappedCondition)) {
    const operatorKind = unwrappedCondition.operatorToken.kind;
    if (
      (!negated && operatorKind === ts.SyntaxKind.AmpersandAmpersandToken) ||
      (negated && operatorKind === ts.SyntaxKind.BarBarToken)
    ) {
      return (
        conditionProvesTarget(castContext, unwrappedCondition.left, negated) ||
        conditionProvesTarget(castContext, unwrappedCondition.right, negated)
      );
    }
    if (!negated) {
      return instanceOfConditionProvesTarget(castContext, unwrappedCondition);
    }
  }
  if (negated) {
    return false;
  }
  if (ts.isCallExpression(unwrappedCondition)) {
    return callConditionProvesTarget(castContext, unwrappedCondition);
  }
  return isSafeWrapperFlagCondition(castContext, unwrappedCondition);
}

function extractExpectationTrueCondition(callExpression) {
  if (
    !ts.isCallExpression(callExpression) ||
    !ts.isPropertyAccessExpression(callExpression.expression)
  ) {
    return null;
  }
  const memberAccess = callExpression.expression;
  const matcherName = memberAccess.name.text;
  const isTrueMatcher =
    matcherName === "toBeTruthy" ||
    (matcherName === "toBe" &&
      callExpression.arguments.length === 1 &&
      callExpression.arguments[0].kind === ts.SyntaxKind.TrueKeyword);
  if (!isTrueMatcher) {
    return null;
  }
  const expectationCall = memberAccess.expression;
  if (
    !ts.isCallExpression(expectationCall) ||
    !ts.isIdentifier(expectationCall.expression) ||
    expectationCall.arguments.length !== 1
  ) {
    return null;
  }
  return expectationCall.arguments[0];
}

function checkEnclosingBranchProof(castContext, parentNode, childNode) {
  const { typeChecker, tsExpression } = castContext;
  if (changesOperand(typeChecker, childNode, tsExpression)) {
    return null;
  }
  if (ts.isIfStatement(parentNode)) {
    if (
      parentNode.thenStatement === childNode &&
      conditionProvesTarget(castContext, parentNode.expression, false)
    ) {
      return "branch_guard";
    }
    if (
      parentNode.elseStatement === childNode &&
      conditionProvesTarget(castContext, parentNode.expression, true)
    ) {
      return "branch_guard";
    }
  }
  if (ts.isConditionalExpression(parentNode)) {
    if (
      parentNode.whenTrue === childNode &&
      conditionProvesTarget(castContext, parentNode.condition, false)
    ) {
      return "branch_guard";
    }
    if (
      parentNode.whenFalse === childNode &&
      conditionProvesTarget(castContext, parentNode.condition, true)
    ) {
      return "branch_guard";
    }
  }
  if (
    ts.isBinaryExpression(parentNode) &&
    parentNode.right === childNode &&
    parentNode.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    conditionProvesTarget(castContext, parentNode.left, false)
  ) {
    return "branch_guard";
  }
  return null;
}

function checkPrecedingStatementProof(castContext, priorStatement) {
  if (
    ts.isIfStatement(priorStatement) &&
    !priorStatement.elseStatement &&
    statementAlwaysExits(priorStatement.thenStatement) &&
    conditionProvesTarget(castContext, priorStatement.expression, true)
  ) {
    return "early_exit_guard";
  }
  if (!ts.isExpressionStatement(priorStatement)) {
    return null;
  }
  const expression = priorStatement.expression;
  if (isExpectationInstanceCheck(castContext, expression)) {
    return "instance_check";
  }
  const expectationCondition = extractExpectationTrueCondition(expression);
  if (
    expectationCondition &&
    conditionProvesTarget(castContext, expectationCondition, false)
  ) {
    return "condition_check";
  }
  if (isAssertsCallProof(castContext, expression)) {
    return "asserts_call";
  }
  return null;
}

function isStatementContainerNode(node) {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

function findDominatingProof(castContext) {
  const { typeChecker, tsAssertion, tsExpression } = castContext;
  if (!tsAssertion || !tsExpression) {
    return null;
  }
  let decodedCandidate = isDecodedValueCast(castContext);
  for (
    let currentNode = tsAssertion;
    currentNode.parent && !ts.isFunctionLike(currentNode.parent);
    currentNode = currentNode.parent
  ) {
    const parentNode = currentNode.parent;
    const branchProof = checkEnclosingBranchProof(
      castContext,
      parentNode,
      currentNode
    );
    if (branchProof) {
      return branchProof;
    }
    if (!isStatementContainerNode(parentNode)) {
      continue;
    }
    const statementList = parentNode.statements;
    const currentIndex = statementList.indexOf(currentNode);
    if (currentIndex === -1) {
      continue;
    }
    for (
      let statementIndex = currentIndex - 1;
      statementIndex >= 0;
      statementIndex -= 1
    ) {
      const priorStatement = statementList[statementIndex];
      if (changesOperand(typeChecker, priorStatement, tsExpression)) {
        decodedCandidate = false;
        return null;
      }
      const proofKind = checkPrecedingStatementProof(
        castContext,
        priorStatement
      );
      if (proofKind) {
        return proofKind;
      }
    }
  }
  return decodedCandidate ? "schema_decode" : null;
}

function isTypePredicateParameterCast(castContext) {
  const { castNode, tsExpression, typeChecker } = castContext;
  let ancestorNode = castNode.parent;
  while (ancestorNode) {
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(ancestorNode.type)
    ) {
      const predicateAnnotation = ancestorNode.returnType?.typeAnnotation;
      if (
        predicateAnnotation?.type !== "TSTypePredicate" ||
        predicateAnnotation.parameterName?.type !== "Identifier"
      ) {
        return false;
      }
      const paramName = predicateAnnotation.parameterName.name;
      const rootExpr = expressionRoot(tsExpression);
      if (!rootExpr || !ts.isIdentifier(rootExpr)) {
        return false;
      }
      if (rootExpr.text === paramName) {
        return true;
      }
      const initExpr = resolveSingleInitializerExpression(
        typeChecker,
        rootExpr
      );
      const unwrappedInit = expressionRoot(initExpr);
      return Boolean(
        unwrappedInit &&
        ts.isIdentifier(unwrappedInit) &&
        unwrappedInit.text === paramName
      );
    }
    ancestorNode = ancestorNode.parent;
  }
  return false;
}

function buildCastEvaluationContext(castNode, parserServices, typeChecker) {
  const program = parserServices.program;
  const tsExpression = parserServices.esTreeNodeToTSNodeMap.get(
    castNode.expression
  );
  const tsTypeNode = parserServices.esTreeNodeToTSNodeMap.get(
    castNode.typeAnnotation
  );
  const tsAssertion = parserServices.esTreeNodeToTSNodeMap.get(castNode);

  const sourceType = tsExpression
    ? typeChecker.getTypeAtLocation(tsExpression)
    : null;
  const targetType = tsTypeNode
    ? typeChecker.getTypeFromTypeNode(tsTypeNode)
    : null;
  const unresolved = findCastUnresolvedProvenance(
    program,
    typeChecker,
    tsExpression,
    tsTypeNode,
    sourceType,
    targetType
  );

  return {
    castNode,
    program,
    tsExpression,
    tsTypeNode,
    tsAssertion,
    sourceType,
    targetType,
    unresolved,
    typeChecker,
    parserServices,
  };
}

const CAST_DECISION_TABLE = [
  {
    decisionKind: "unresolved_type_analysis",
    resolutionAction: "incomplete",
    rationale:
      "TypeScript could not resolve a module or name reached by the cast's source or target, or resolved a compiler error type.",
    matches: (castContext) => Boolean(castContext.unresolved),
  },
  {
    decisionKind: "double_cast_chain",
    resolutionAction: "clear",
    rationale: "Chained type assertion owned by no-unsafe-cast-chain.",
    matches: ({ castNode }) =>
      Boolean(
        (castNode.expression?.type === "TSAsExpression" &&
          ["TSUnknownKeyword", "TSAnyKeyword"].includes(
            castNode.expression.typeAnnotation?.type
          )) ||
        castNode.parent?.type === "TSAsExpression"
      ),
  },
  {
    decisionKind: "type_predicate_implementation",
    resolutionAction: "clear",
    rationale:
      "Cast of a type predicate function's parameter inside its body to inspect fields for the guard.",
    matches: isTypePredicateParameterCast,
  },
  {
    decisionKind: "non_broad_source",
    resolutionAction: "clear",
    rationale: "Resolved source type is not any or unknown.",
    matches: (castContext) =>
      !isAppeasementCastSourceType(castContext.sourceType),
  },
  {
    decisionKind: "non_narrowing_target",
    resolutionAction: "clear",
    rationale:
      "Resolved target type is any or unknown and claims no contract beyond the source.",
    matches: (castContext) =>
      isAppeasementCastSourceType(castContext.targetType),
  },
  {
    decisionKind: "dominating_runtime_proof",
    resolutionAction: "clear",
    rationale:
      "Dominating runtime assertion, type guard, or recognised schema decode proves the target contract for the cast value.",
    matches: (castContext) => Boolean(findDominatingProof(castContext)),
  },
  {
    decisionKind: "broad_source_to_unproven_contract",
    resolutionAction: "report",
    rationale:
      "Casting any or unknown into a target contract without a dominating runtime proof.",
    matches: () => true,
  },
];

export function inspectAppeasementCast(castNode, parserServices, typeChecker) {
  const castContext = buildCastEvaluationContext(
    castNode,
    parserServices,
    typeChecker
  );
  for (const tableEntry of CAST_DECISION_TABLE) {
    if (tableEntry.matches(castContext)) {
      return {
        action: tableEntry.resolutionAction,
        decisionKind: tableEntry.decisionKind,
        rationale: tableEntry.rationale,
        unresolved: castContext.unresolved,
        message:
          tableEntry.resolutionAction === "incomplete"
            ? formatIncompleteAnalysisMessage(castContext.unresolved)
            : null,
      };
    }
  }
  throw new Error("Unreachable: CAST_DECISION_TABLE is exhaustive.");
}
