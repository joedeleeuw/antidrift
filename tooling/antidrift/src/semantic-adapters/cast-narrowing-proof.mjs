import ts from "typescript";
import { isAppeasementCastSourceType } from "./broad-input.mjs";

const referenceIndexByChecker = new WeakMap();

const NON_PRIMITIVE_FLAGS = ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive;

const EXECUTION_YIELDING_KINDS = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
]);

const EQUALITY_OPERATOR_KINDS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

export function skipTransparentExpressions(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function memberKeyText(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  const key = expression.argumentExpression;
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
    ? key.text
    : null;
}

export function referenceChain(expression) {
  const memberNames = [];
  let current = skipTransparentExpressions(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const keyText = memberKeyText(current);
    if (keyText === null) {
      return null;
    }
    memberNames.unshift(keyText);
    current = skipTransparentExpressions(current.expression);
  }
  if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) {
    return { root: current, memberNames };
  }
  return null;
}

function isAutoTypedVariable(symbol) {
  const declaration = symbol.valueDeclaration;
  return Boolean(
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    !declaration.type &&
    !declaration.initializer &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent)
  );
}

function indexedMemberType(typeChecker, objectType, keyNode) {
  const keyIsNumeric = keyNode && ts.isNumericLiteral(keyNode);
  const indexSignatures = typeChecker.getIndexInfosOfType(objectType);
  const keyedSignature =
    indexSignatures.find((signature) =>
      keyIsNumeric
        ? signature.keyType.flags & ts.TypeFlags.NumberLike
        : signature.keyType.flags & ts.TypeFlags.StringLike
    ) ?? indexSignatures[0];
  return keyedSignature?.type ?? null;
}

function declaredMemberType(typeChecker, member) {
  const objectType = typeChecker.getTypeAtLocation(member.expression);
  if (objectType.flags & ts.TypeFlags.Any) {
    return objectType;
  }
  const keyNode = ts.isPropertyAccessExpression(member)
    ? member.name
    : member.argumentExpression;
  const memberSymbol =
    memberKeyText(member) === null
      ? null
      : typeChecker.getSymbolAtLocation(keyNode);
  if (memberSymbol && !(memberSymbol.flags & ts.SymbolFlags.Signature)) {
    return typeChecker.getTypeOfSymbol(memberSymbol);
  }
  return indexedMemberType(typeChecker, objectType, keyNode);
}

export function isBroadSourceType(typeChecker, type) {
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = typeChecker.getBaseConstraintOfType(type);
    return !constraint || isBroadSourceType(typeChecker, constraint);
  }
  return isAppeasementCastSourceType(type);
}

export function declaredOperandType(typeChecker, operand, flowType) {
  const reference = skipTransparentExpressions(operand);
  if (ts.isIdentifier(reference)) {
    const symbol = typeChecker.getSymbolAtLocation(reference);
    return symbol && !isAutoTypedVariable(symbol)
      ? typeChecker.getTypeOfSymbol(symbol)
      : flowType;
  }
  if (
    ts.isPropertyAccessExpression(reference) ||
    ts.isElementAccessExpression(reference)
  ) {
    return declaredMemberType(typeChecker, reference) ?? flowType;
  }
  return flowType;
}

function unionConstituents(type) {
  return type.flags & ts.TypeFlags.Union ? type.types : [type];
}

function isReferenceType(type) {
  return Boolean(
    type.flags & ts.TypeFlags.Object &&
    type.objectFlags & ts.ObjectFlags.Reference
  );
}

export function sameType(typeChecker, left, right) {
  if (left === right) {
    return true;
  }
  if (
    !isReferenceType(left) ||
    !isReferenceType(right) ||
    left.target !== right.target
  ) {
    return false;
  }
  const leftArguments = typeChecker.getTypeArguments(left);
  const rightArguments = typeChecker.getTypeArguments(right);
  return (
    leftArguments.length === rightArguments.length &&
    leftArguments.every((argument, index) =>
      sameType(typeChecker, argument, rightArguments[index])
    )
  );
}

function indexTypesOf(typeChecker, type) {
  return typeChecker
    .getIndexInfosOfType(type)
    .map((signature) => [signature.keyType, signature.type]);
}

function elementTypeOf(typeChecker, type) {
  if (isReferenceType(type) && typeChecker.isArrayLikeType(type)) {
    return typeChecker.getTypeArguments(type)[0] ?? null;
  }
  return typeChecker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null;
}

function anyProvesMember(typeChecker, flowType, targetType, seen) {
  if (targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return false;
  }
  if (flowType.flags & ts.TypeFlags.Any) {
    return true;
  }
  return anyProvesDifferent(typeChecker, flowType, targetType, seen);
}

function anyProvesStructure(typeChecker, flowType, targetType, seen) {
  if (typeChecker.isArrayLikeType(targetType)) {
    const flowElement = elementTypeOf(typeChecker, flowType);
    const targetElement = elementTypeOf(typeChecker, targetType);
    return Boolean(
      flowElement &&
      targetElement &&
      anyProvesMember(typeChecker, flowElement, targetElement, seen)
    );
  }
  if (
    isReferenceType(flowType) &&
    isReferenceType(targetType) &&
    flowType.target === targetType.target
  ) {
    const targetArguments = typeChecker.getTypeArguments(targetType);
    return typeChecker
      .getTypeArguments(flowType)
      .some((argument, index) =>
        anyProvesMember(typeChecker, argument, targetArguments[index], seen)
      );
  }
  const properties = typeChecker.getPropertiesOfType(targetType).some((property) => {
    const flowProperty = typeChecker.getPropertyOfType(flowType, property.name);
    return Boolean(
      flowProperty &&
      anyProvesMember(
        typeChecker,
        typeChecker.getTypeOfSymbol(flowProperty),
        typeChecker.getTypeOfSymbol(property),
        seen
      )
    );
  });
  if (properties) {
    return true;
  }
  const flowIndexTypes = indexTypesOf(typeChecker, flowType);
  return indexTypesOf(typeChecker, targetType).some(([keyType, valueType]) =>
    flowIndexTypes.some(
      ([flowKeyType, flowValueType]) =>
        flowKeyType === keyType &&
        anyProvesMember(typeChecker, flowValueType, valueType, seen)
    )
  );
}

function anyProvesDifferent(typeChecker, flowType, targetType, seen) {
  if (sameType(typeChecker, flowType, targetType)) {
    return false;
  }
  const key = `${typeChecker.typeToString(flowType)}\u0000${typeChecker.typeToString(targetType)}`;
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return unionConstituents(flowType).some((constituent) => {
    const admitted = unionConstituents(targetType).filter((candidate) =>
      typeChecker.isTypeAssignableTo(constituent, candidate)
    );
    return (
      admitted.length > 0 &&
      admitted.every((candidate) =>
        anyProvesStructure(typeChecker, constituent, candidate, seen)
      )
    );
  });
}

function isNonPrimitiveType(type) {
  return unionConstituents(type).every((constituent) =>
    constituent.flags & ts.TypeFlags.Intersection
      ? constituent.types.some((member) => member.flags & NON_PRIMITIVE_FLAGS)
      : Boolean(constituent.flags & NON_PRIMITIVE_FLAGS)
  );
}

function claimsOnlyUnknownValuedKeys(typeChecker, targetType) {
  const indexTypes = typeChecker
    .getIndexInfosOfType(targetType)
    .map((signature) => signature.type);
  return (
    Boolean(targetType.flags & ts.TypeFlags.Object) &&
    typeChecker.getPropertiesOfType(targetType).length === 0 &&
    targetType.getCallSignatures().length === 0 &&
    targetType.getConstructSignatures().length === 0 &&
    indexTypes.length > 0 &&
    indexTypes.every((indexType) => indexType.flags & ts.TypeFlags.Unknown)
  );
}

export function narrowingProvesTarget(typeChecker, flowType, targetType) {
  if (isBroadSourceType(typeChecker, flowType)) {
    return false;
  }
  if (sameType(typeChecker, flowType, targetType)) {
    return true;
  }
  if (typeChecker.isTypeAssignableTo(flowType, targetType)) {
    return !anyProvesDifferent(typeChecker, flowType, targetType, new Set());
  }
  return (
    isNonPrimitiveType(flowType) &&
    !typeChecker.isArrayLikeType(targetType) &&
    claimsOnlyUnknownValuedKeys(typeChecker, targetType)
  );
}

function referenceIndex(typeChecker, sourceFile) {
  let indexBySourceFile = referenceIndexByChecker.get(typeChecker);
  if (!indexBySourceFile) {
    indexBySourceFile = new WeakMap();
    referenceIndexByChecker.set(typeChecker, indexBySourceFile);
  }
  let occurrencesBySymbol = indexBySourceFile.get(sourceFile);
  if (occurrencesBySymbol) {
    return occurrencesBySymbol;
  }
  occurrencesBySymbol = new Map();
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const symbol = typeChecker.getSymbolAtLocation(node);
      if (symbol) {
        const occurrences = occurrencesBySymbol.get(symbol) ?? [];
        occurrences.push(node);
        occurrencesBySymbol.set(symbol, occurrences);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  indexBySourceFile.set(sourceFile, occurrencesBySymbol);
  return occurrencesBySymbol;
}

function enclosingContainer(node) {
  return (
    ts.findAncestor(
      node.parent,
      (ancestor) => ts.isFunctionLike(ancestor) || ts.isSourceFile(ancestor)
    ) ?? node.getSourceFile()
  );
}

function thisContainer(node) {
  return (
    ts.findAncestor(
      node.parent,
      (ancestor) =>
        (ts.isFunctionLike(ancestor) && !ts.isArrowFunction(ancestor)) ||
        ts.isClassLike(ancestor) ||
        ts.isSourceFile(ancestor)
    ) ?? node.getSourceFile()
  );
}

function collectThisOccurrences(container) {
  const occurrences = [];
  function visit(node) {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      occurrences.push(node);
      return;
    }
    if (
      node !== container &&
      ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
        ts.isClassLike(node))
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(container);
  return occurrences;
}

function rootOccurrences(typeChecker, chain) {
  if (chain.root.kind === ts.SyntaxKind.ThisKeyword) {
    return collectThisOccurrences(thisContainer(chain.root));
  }
  const symbol = typeChecker.getSymbolAtLocation(chain.root);
  if (!symbol) {
    return [];
  }
  return (
    referenceIndex(typeChecker, chain.root.getSourceFile()).get(symbol) ?? []
  );
}

function chainOccurrence(rootOccurrence, memberNames) {
  let occurrence = rootOccurrence;
  const occurrences = [rootOccurrence];
  for (const memberName of memberNames) {
    const parent = occurrence.parent;
    const extendsChain =
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === occurrence &&
      memberKeyText(parent) === memberName;
    if (!extendsChain) {
      break;
    }
    occurrence = parent;
    occurrences.push(occurrence);
  }
  return occurrences;
}

function referenceOccurrences(typeChecker, chain) {
  return rootOccurrences(typeChecker, chain).flatMap((rootOccurrence) =>
    chainOccurrence(rootOccurrence, chain.memberNames)
  );
}

function isAssignmentTarget(node) {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  return (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function rootAssignedInNestedFunction(typeChecker, chain) {
  if (chain.root.kind === ts.SyntaxKind.ThisKeyword) {
    return null;
  }
  const symbol = typeChecker.getSymbolAtLocation(chain.root);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) {
    return null;
  }
  const declarationContainer = enclosingContainer(declaration);
  return (
    rootOccurrences(typeChecker, chain).find(
      (occurrence) =>
        isAssignmentTarget(skipOuterParents(occurrence)) &&
        enclosingContainer(occurrence) !== declarationContainer
    ) ?? null
  );
}

function skipOuterParents(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

function enclosingIterationStatement(node, boundary) {
  return ts.findAncestor(node.parent, (ancestor) => {
    if (ancestor === boundary) {
      return "quit";
    }
    return ts.isIterationStatement(ancestor, false);
  });
}

function executesBeforeCast(node, castNode, loop) {
  if (node.end <= castNode.getStart()) {
    return true;
  }
  return Boolean(
    loop &&
    node.pos >= loop.pos &&
    node.end <= loop.end &&
    !(node.pos <= castNode.pos && node.end >= castNode.end)
  );
}

function sameRoot(typeChecker, leftRoot, rightRoot) {
  if (leftRoot.kind !== rightRoot.kind) {
    return false;
  }
  if (leftRoot.kind === ts.SyntaxKind.ThisKeyword) {
    return thisContainer(leftRoot) === thisContainer(rightRoot);
  }
  const leftSymbol = typeChecker.getSymbolAtLocation(leftRoot);
  return Boolean(
    leftSymbol && leftSymbol === typeChecker.getSymbolAtLocation(rightRoot)
  );
}

function isChainPrefixSpelling(typeChecker, node, chain) {
  const nodeChain = referenceChain(node);
  return Boolean(
    nodeChain &&
    sameRoot(typeChecker, nodeChain.root, chain.root) &&
    nodeChain.memberNames.length <= chain.memberNames.length &&
    nodeChain.memberNames.every(
      (memberName, index) => chain.memberNames[index] === memberName
    )
  );
}

function callHasTypePredicate(typeChecker, call) {
  const signature = typeChecker.getResolvedSignature(call);
  return Boolean(signature && typeChecker.getTypePredicateOfSignature(signature));
}

function receivesReference(typeChecker, call, chain) {
  const operands = ts.isPropertyAccessExpression(call.expression)
    ? [...call.arguments, call.expression.expression]
    : call.arguments;
  return operands.some(
    (operand) =>
      referenceChain(operand)?.memberNames.length ===
        chain.memberNames.length &&
      isChainPrefixSpelling(typeChecker, operand, chain)
  );
}

function testsProvedReference(typeChecker, node, chain) {
  return (
    ts.isCallExpression(node) &&
    callHasTypePredicate(typeChecker, node) &&
    receivesReference(typeChecker, node, chain)
  );
}

function mutatesChainMember(typeChecker, node, chain) {
  const isDelete = ts.isDeleteExpression(node);
  const target = isDelete ? skipTransparentExpressions(node.expression) : node;
  if (
    !(isDelete || isAssignmentTarget(node)) ||
    !(
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    )
  ) {
    return false;
  }
  const keyText = memberKeyText(target);
  return (
    (keyText === null || chain.memberNames.includes(keyText)) &&
    (isDelete || !isChainPrefixSpelling(typeChecker, target, chain))
  );
}

function governsCast(testNode, castNode) {
  const governing = ts.findAncestor(testNode, (ancestor) => {
    if (ts.isFunctionLike(ancestor) || ts.isSourceFile(ancestor)) {
      return "quit";
    }
    if (
      ts.isIfStatement(ancestor) ||
      ts.isWhileStatement(ancestor) ||
      ts.isForStatement(ancestor) ||
      ts.isConditionalExpression(ancestor) ||
      ts.isSwitchStatement(ancestor)
    ) {
      return true;
    }
    if (ts.isExpressionStatement(ancestor)) {
      return true;
    }
    return false;
  });
  if (!governing) {
    return false;
  }
  if (ts.isExpressionStatement(governing)) {
    return (
      ts.isCallExpression(skipTransparentExpressions(governing.expression)) &&
      governing.end <= castNode.getStart() &&
      ts.findAncestor(castNode, (ancestor) => ancestor === governing.parent) !==
        undefined
    );
  }
  return (
    governing.pos <= castNode.pos &&
    governing.end >= castNode.end &&
    testNode.end <= castNode.getStart()
  );
}

function establishesProof(typeChecker, occurrence) {
  const reference = skipOuterParents(occurrence);
  const parent = reference.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(reference)) {
    return callHasTypePredicate(typeChecker, parent);
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    return (
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      callHasTypePredicate(typeChecker, parent.parent)
    );
  }
  return testConsumers(occurrence).length > 0;
}

function proofPoint(typeChecker, chain, castNode, body) {
  let latest = null;
  for (const occurrence of referenceOccurrences(typeChecker, chain)) {
    const tested = skipOuterParents(occurrence);
    if (
      tested.end > castNode.getStart() ||
      enclosingContainer(tested) !== body ||
      !establishesProof(typeChecker, occurrence) ||
      !governsCast(tested, castNode)
    ) {
      continue;
    }
    if (!latest || tested.end > latest.end) {
      latest = tested;
    }
  }
  return latest;
}

function windowDisruption(typeChecker, chain, castNode) {
  const body = enclosingContainer(castNode);
  const loop = enclosingIterationStatement(castNode, body);
  const proof = proofPoint(typeChecker, chain, castNode, body);
  const windowStart = proof ? proof.end : body.pos;
  const windowEnd = loop ? Math.max(loop.end, castNode.end) : castNode.end;
  let disruption = null;
  function visit(node) {
    if (
      disruption ||
      node === castNode ||
      node.pos >= windowEnd ||
      node.end <= windowStart ||
      (node !== body && ts.isFunctionLike(node))
    ) {
      return;
    }
    if (
      executesBeforeCast(node, castNode, loop) &&
      node.getStart() >= windowStart &&
      EXECUTION_YIELDING_KINDS.has(node.kind) &&
      !testsProvedReference(typeChecker, node, chain)
    ) {
      disruption = { node, kind: "call" };
      return;
    }
    if (
      executesBeforeCast(node, castNode, loop) &&
      node.getStart() >= windowStart &&
      mutatesChainMember(typeChecker, node, chain)
    ) {
      disruption = { node, kind: "member write" };
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return disruption;
}

export function narrowingDisruption(typeChecker, operand, castNode) {
  const chain = referenceChain(operand);
  if (!chain) {
    return null;
  }
  const nestedWrite = rootAssignedInNestedFunction(typeChecker, chain);
  if (nestedWrite) {
    return { node: nestedWrite, kind: "write in a nested function" };
  }
  return chain.memberNames.length === 0
    ? null
    : windowDisruption(typeChecker, chain, castNode);
}

function testConsumers(occurrence) {
  const reference = skipOuterParents(occurrence);
  const parent = reference.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(reference)) {
    return [parent.expression, ...(parent.typeArguments ?? [])];
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return [parent];
  }
  if (ts.isBinaryExpression(parent)) {
    const operatorKind = parent.operatorToken.kind;
    if (
      operatorKind === ts.SyntaxKind.InstanceOfKeyword &&
      parent.left === reference
    ) {
      return [parent.right];
    }
    if (EQUALITY_OPERATOR_KINDS.has(operatorKind)) {
      return [parent.left === reference ? parent.right : parent.left];
    }
  }
  if (ts.isSwitchStatement(parent) && parent.expression === reference) {
    return parent.caseBlock.clauses.flatMap((clause) =>
      ts.isCaseClause(clause) ? [clause.expression] : []
    );
  }
  return [];
}

export function proofCandidateNodes(typeChecker, operand, castNode) {
  const chain = referenceChain(operand);
  if (!chain) {
    return [];
  }
  const body = enclosingContainer(castNode);
  const loop = enclosingIterationStatement(castNode, body);
  return referenceOccurrences(typeChecker, chain)
    .filter((occurrence) => {
      const tested = skipOuterParents(occurrence);
      return (
        executesBeforeCast(tested, castNode, loop) &&
        ts.findAncestor(tested, (ancestor) => ancestor === body) !== undefined
      );
    })
    .flatMap(testConsumers);
}
