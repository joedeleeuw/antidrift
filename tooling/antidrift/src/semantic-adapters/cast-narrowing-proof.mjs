import ts from "typescript";
import { boundaryObservations } from "./boundary-observations.mjs";
import { isAppeasementCastSourceType } from "./boundary/broad-input-type.ts";

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

function elementTypesOf(typeChecker, type) {
  if (isReferenceType(type) && typeChecker.isArrayLikeType(type)) {
    return typeChecker.getTypeArguments(type);
  }
  const indexed = typeChecker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return indexed ? [indexed] : [];
}

function anyProvesElements(typeChecker, flowType, targetType, seen) {
  const flowElements = elementTypesOf(typeChecker, flowType);
  const targetElements = elementTypesOf(typeChecker, targetType);
  if (!flowElements.length || !targetElements.length) {
    return false;
  }
  if (typeChecker.isTupleType(targetType)) {
    const flowIsTuple = typeChecker.isTupleType(flowType);
    return targetElements.some((targetElement, index) => {
      const flowElement = flowIsTuple ? flowElements[index] : flowElements[0];
      return (
        Boolean(flowElement) &&
        anyProvesDifferent(typeChecker, flowElement, targetElement, seen)
      );
    });
  }
  return flowElements.some((flowElement) =>
    anyProvesDifferent(typeChecker, flowElement, targetElements[0], seen)
  );
}

const REPEATING_ELEMENT_FLAGS = ts.ElementFlags.Rest | ts.ElementFlags.Variadic;

function restSegments(typeChecker, restType) {
  const elements = elementTypesOf(typeChecker, restType);
  if (!typeChecker.isTupleType(restType)) {
    return elements.length ? [{ type: elements[0], repeats: true }] : [];
  }
  const flags = restType.target?.elementFlags ?? [];
  return elements.map((type, index) => ({
    type,
    repeats: Boolean(flags[index] & REPEATING_ELEMENT_FLAGS),
  }));
}

function parameterShape(typeChecker, signature) {
  const segments = [];
  for (const parameter of signature.parameters) {
    const type = typeChecker.getTypeOfSymbol(parameter);
    const declaration = parameter.valueDeclaration;
    if (
      declaration &&
      ts.isParameter(declaration) &&
      declaration.dotDotDotToken
    ) {
      segments.push(...restSegments(typeChecker, type));
    } else {
      segments.push({ type, repeats: false });
    }
  }
  const receiver =
    signature.thisParameter &&
    typeChecker.getTypeOfSymbol(signature.thisParameter);
  const firstRepeat = segments.findIndex((segment) => segment.repeats);
  if (firstRepeat < 0) {
    return { prefix: segments, repeating: [], suffix: [], receiver };
  }
  const lastRepeat = segments.findLastIndex((segment) => segment.repeats);
  return {
    prefix: segments.slice(0, firstRepeat),
    repeating: segments.slice(firstRepeat, lastRepeat + 1),
    suffix: segments.slice(lastRepeat + 1),
    receiver: receiver ?? null,
  };
}

function sameShape(flow, target) {
  return (
    flow.prefix.length === target.prefix.length &&
    flow.repeating.length === target.repeating.length &&
    flow.suffix.length === target.suffix.length
  );
}

function typesFromFront(shape, index) {
  if (index < shape.prefix.length) {
    return [shape.prefix[index].type];
  }
  return shape.repeating.map((segment) => segment.type);
}

function typesFromBack(shape, index) {
  const tail = shape.repeating.length ? shape.suffix : shape.prefix;
  if (index < tail.length) {
    return [tail[tail.length - 1 - index].type];
  }
  return shape.repeating.map((segment) => segment.type);
}

function segmentCount(shape) {
  return shape.prefix.length + shape.repeating.length + shape.suffix.length;
}

function anyProvesParameters(
  typeChecker,
  flowSignature,
  targetSignature,
  seen
) {
  const flow = parameterShape(typeChecker, flowSignature);
  const target = parameterShape(typeChecker, targetSignature);
  if (
    flow.receiver &&
    target.receiver &&
    anyProvesDifferent(typeChecker, flow.receiver, target.receiver, seen)
  ) {
    return true;
  }
  if (sameShape(flow, target)) {
    return ["prefix", "repeating", "suffix"].some((part) =>
      flow[part].some((segment, index) =>
        anyProvesDifferent(
          typeChecker,
          segment.type,
          target[part][index].type,
          seen
        )
      )
    );
  }
  const alignTail = flow.repeating.length > 0 || target.repeating.length > 0;
  const positions = segmentCount(flow) + segmentCount(target);
  for (let index = 0; index < positions; index += 1) {
    const alignments = [
      [typesFromFront(flow, index), typesFromFront(target, index)],
      ...(alignTail
        ? [[typesFromBack(flow, index), typesFromBack(target, index)]]
        : []),
    ];
    if (
      alignments.some(([flowTypes, targetTypes]) =>
        flowTypes.some((flowType) =>
          targetTypes.some((targetType) =>
            anyProvesDifferent(typeChecker, flowType, targetType, seen)
          )
        )
      )
    ) {
      return true;
    }
  }
  return false;
}

function anyProvesSignatures(typeChecker, flowType, targetType, seen) {
  return ["getCallSignatures", "getConstructSignatures"].some((method) => {
    const flowSignatures = flowType[method]();
    return targetType[method]().some((targetSignature, index) => {
      const flowSignature = flowSignatures[index] ?? flowSignatures[0];
      if (!flowSignature) {
        return false;
      }
      return (
        anyProvesDifferent(
          typeChecker,
          typeChecker.getReturnTypeOfSignature(flowSignature),
          typeChecker.getReturnTypeOfSignature(targetSignature),
          seen
        ) ||
        anyProvesParameters(typeChecker, flowSignature, targetSignature, seen)
      );
    });
  });
}

function anyProvesStructure(typeChecker, flowType, targetType, seen) {
  if (
    typeChecker.isArrayLikeType(targetType) &&
    anyProvesElements(typeChecker, flowType, targetType, seen)
  ) {
    return true;
  }
  if (anyProvesSignatures(typeChecker, flowType, targetType, seen)) {
    return true;
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
        anyProvesDifferent(typeChecker, argument, targetArguments[index], seen)
      );
  }
  const properties = typeChecker
    .getPropertiesOfType(targetType)
    .some((property) => {
      const flowProperty = typeChecker.getPropertyOfType(
        flowType,
        property.name
      );
      return Boolean(
        flowProperty &&
        anyProvesDifferent(
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
        anyProvesDifferent(typeChecker, flowValueType, valueType, seen)
    )
  );
}

const SEEN_TYPE_PAIRS = boundaryObservations.bounds.narrowingProofPairCap.limit;

function anyProvesDifferent(typeChecker, flowType, targetType, seen) {
  if (targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return false;
  }
  if (flowType.flags & ts.TypeFlags.Any) {
    return true;
  }
  if (sameType(typeChecker, flowType, targetType)) {
    return false;
  }
  const seenTargets = seen.get(flowType) ?? new Set();
  if (seenTargets.has(targetType)) {
    return false;
  }
  if (seen.size > SEEN_TYPE_PAIRS) {
    seen.capped = true;
    return false;
  }
  seenTargets.add(targetType);
  seen.set(flowType, seenTargets);
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

export function narrowingProvesTarget(
  typeChecker,
  flowType,
  targetType,
  onPairCap
) {
  if (isBroadSourceType(typeChecker, flowType)) {
    return false;
  }
  if (sameType(typeChecker, flowType, targetType)) {
    return true;
  }
  if (typeChecker.isTypeAssignableTo(flowType, targetType)) {
    const seen = new Map();
    const different = anyProvesDifferent(
      typeChecker,
      flowType,
      targetType,
      seen
    );
    if (seen.capped && onPairCap) {
      onPairCap();
    }
    return !different;
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
  const occurrences = [{ node: rootOccurrence, remainder: memberNames }];
  for (const [index, memberName] of memberNames.entries()) {
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
    occurrences.push({
      node: occurrence,
      remainder: memberNames.slice(index + 1),
    });
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
  return Boolean(
    signature && typeChecker.getTypePredicateOfSignature(signature)
  );
}

function callOperands(call) {
  return ts.isPropertyAccessExpression(call.expression)
    ? [...call.arguments, call.expression.expression]
    : call.arguments;
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

const GOVERNING_CONDITION = {
  [ts.SyntaxKind.IfStatement]: (statement) => statement.expression,
  [ts.SyntaxKind.WhileStatement]: (statement) => statement.expression,
  [ts.SyntaxKind.DoStatement]: (statement) => statement.expression,
  [ts.SyntaxKind.ForStatement]: (statement) => statement.condition,
  [ts.SyntaxKind.ConditionalExpression]: (expression) => expression.condition,
  [ts.SyntaxKind.SwitchStatement]: (statement) => statement.expression,
};

function governingConstruct(testNode) {
  return ts.findAncestor(testNode, (ancestor) => {
    if (ts.isFunctionLike(ancestor) || ts.isSourceFile(ancestor)) {
      return "quit";
    }
    return (
      ancestor.kind in GOVERNING_CONDITION || ts.isExpressionStatement(ancestor)
    );
  });
}

function alwaysExits(statement) {
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return Boolean(last) && alwaysExits(last);
  }
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

function isWithin(node, container) {
  return (
    Boolean(container) &&
    ts.findAncestor(node, (ancestor) => ancestor === container) !== undefined
  );
}

function isEarlyExitGuard(statement, castNode) {
  return (
    ts.isIfStatement(statement) &&
    !statement.elseStatement &&
    alwaysExits(statement.thenStatement) &&
    statement.end <= castNode.getStart() &&
    isWithin(castNode, statement.parent)
  );
}

const OBJECT_YIELD = Symbol("object");

const TYPEOF_YIELDS = {
  string: (typeChecker) => typeChecker.getStringType(),
  number: (typeChecker) => typeChecker.getNumberType(),
  boolean: (typeChecker) => typeChecker.getBooleanType(),
  bigint: (typeChecker) => typeChecker.getBigIntType(),
  symbol: (typeChecker) => typeChecker.getESSymbolType(),
  undefined: (typeChecker) => typeChecker.getUndefinedType(),
  object: () => OBJECT_YIELD,
};

function navigateMembers(typeChecker, type, remainder) {
  let current = type;
  for (const memberName of remainder) {
    if (!current || current === OBJECT_YIELD) {
      return null;
    }
    const property = typeChecker.getPropertyOfType(current, memberName);
    current = property
      ? typeChecker.getTypeOfSymbol(property)
      : (typeChecker.getIndexTypeOfType(current, ts.IndexKind.String) ?? null);
  }
  return current;
}

function predicateYield(typeChecker, call, tested) {
  const signature = typeChecker.getResolvedSignature(call);
  const predicate =
    signature && typeChecker.getTypePredicateOfSignature(signature);
  if (!predicate || !predicate.type) {
    return null;
  }
  const subject =
    predicate.kind === ts.TypePredicateKind.Identifier ||
    predicate.kind === ts.TypePredicateKind.AssertsIdentifier
      ? call.arguments[predicate.parameterIndex]
      : ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression;
  const asserts =
    predicate.kind === ts.TypePredicateKind.AssertsIdentifier ||
    predicate.kind === ts.TypePredicateKind.AssertsThis;
  return subject &&
    skipOuterParents(skipTransparentExpressions(subject)) === tested
    ? { type: predicate.type, asserts }
    : null;
}

function nonNullableDeclaredType(typeChecker, tested) {
  return typeChecker.getNonNullableType(
    declaredOperandType(
      typeChecker,
      tested,
      typeChecker.getTypeAtLocation(tested)
    )
  );
}

function isNullishLiteral(node) {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

const NEGATED_EQUALITY_KINDS = new Set([
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function testOf(typeChecker, tested) {
  const parent = tested.parent;
  if (ts.isCallExpression(parent)) {
    const yielded = predicateYield(typeChecker, parent, tested);
    return yielded
      ? { node: parent, yielded: yielded.type, negated: false }
      : null;
  }
  if (ts.isTypeOfExpression(parent) && ts.isBinaryExpression(parent.parent)) {
    const comparison = parent.parent;
    const other =
      comparison.left === parent ? comparison.right : comparison.left;
    const form =
      EQUALITY_OPERATOR_KINDS.has(comparison.operatorToken.kind) &&
      ts.isStringLiteralLike(other) &&
      TYPEOF_YIELDS[other.text];
    return form
      ? {
          node: comparison,
          yielded: form(typeChecker),
          negated: NEGATED_EQUALITY_KINDS.has(comparison.operatorToken.kind),
        }
      : null;
  }
  if (ts.isBinaryExpression(parent)) {
    const operatorKind = parent.operatorToken.kind;
    if (
      operatorKind === ts.SyntaxKind.InstanceOfKeyword &&
      parent.left === tested
    ) {
      const constructSignature = typeChecker
        .getTypeAtLocation(parent.right)
        .getConstructSignatures()[0];
      return constructSignature
        ? {
            node: parent,
            yielded: typeChecker.getReturnTypeOfSignature(constructSignature),
            negated: false,
          }
        : null;
    }
    if (operatorKind === ts.SyntaxKind.InKeyword && parent.right === tested) {
      return { node: parent, yielded: OBJECT_YIELD, negated: false };
    }
    if (EQUALITY_OPERATOR_KINDS.has(operatorKind)) {
      const other = parent.left === tested ? parent.right : parent.left;
      return isNullishLiteral(other)
        ? {
            node: parent,
            yielded: nonNullableDeclaredType(typeChecker, tested),
            negated: !NEGATED_EQUALITY_KINDS.has(operatorKind),
            complement:
              other.kind === ts.SyntaxKind.NullKeyword
                ? typeChecker.getNullType()
                : typeChecker.getUndefinedType(),
          }
        : null;
    }
    if (
      operatorKind === ts.SyntaxKind.AmpersandAmpersandToken ||
      operatorKind === ts.SyntaxKind.BarBarToken
    ) {
      return {
        node: tested,
        yielded: nonNullableDeclaredType(typeChecker, tested),
        negated: false,
      };
    }
    return null;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken) ||
    parent.kind in GOVERNING_CONDITION
  ) {
    return {
      node: tested,
      yielded: nonNullableDeclaredType(typeChecker, tested),
      negated: false,
    };
  }
  return null;
}

function conditionTests(typeChecker, chain, condition, castNode, targetType) {
  const tests = new Map();
  for (const occurrence of referenceOccurrences(typeChecker, chain)) {
    const tested = skipOuterParents(occurrence.node);
    if (!isWithin(tested, condition) || tested.end > castNode.getStart()) {
      continue;
    }
    const test = testOf(typeChecker, tested);
    if (!test) {
      continue;
    }
    const proves = (yielded) => {
      const established =
        yielded && navigateMembers(typeChecker, yielded, occurrence.remainder);
      return Boolean(
        established && yieldProvesTarget(typeChecker, established, targetType)
      );
    };
    tests.set(test.node, {
      negated: test.negated,
      established: proves(test.yielded),
      complement: proves(test.complement ?? null),
    });
  }
  return tests;
}

function conditionProof(node, outcome, tests) {
  const expression = skipTransparentExpressions(node);
  const test = tests.get(expression);
  if (test) {
    const established =
      outcome !== test.negated ? test.established : test.complement;
    return established ? { anchor: expression, skipped: [] } : null;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return conditionProof(expression.operand, !outcome, tests);
  }
  if (!ts.isBinaryExpression(expression)) {
    return null;
  }
  const operatorKind = expression.operatorToken.kind;
  const conjunction = operatorKind === ts.SyntaxKind.AmpersandAmpersandToken;
  if (!conjunction && operatorKind !== ts.SyntaxKind.BarBarToken) {
    return null;
  }
  const left = conditionProof(expression.left, outcome, tests);
  const right = conditionProof(expression.right, outcome, tests);
  if (conjunction === outcome) {
    return right ?? left;
  }
  if (!left || !right) {
    return null;
  }
  return {
    anchor: left.anchor,
    skipped: [
      ...left.skipped,
      ...right.skipped,
      { pos: expression.right.pos, end: right.anchor.end },
    ],
  };
}

function proofWithinCondition(condition, castNode, tests) {
  let current = castNode;
  while (current && current !== condition) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.right === current) {
      const operatorKind = parent.operatorToken.kind;
      const proof =
        operatorKind === ts.SyntaxKind.AmpersandAmpersandToken
          ? conditionProof(parent.left, true, tests)
          : operatorKind === ts.SyntaxKind.BarBarToken &&
            conditionProof(parent.left, false, tests);
      if (proof) {
        return proof;
      }
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== current) {
      const proof = conditionProof(
        parent.condition,
        parent.whenTrue === current,
        tests
      );
      if (proof) {
        return proof;
      }
    }
    current = parent;
  }
  return null;
}

function outcomeReachingCast(governing, castNode) {
  if (ts.isIfStatement(governing)) {
    if (isWithin(castNode, governing.thenStatement)) {
      return true;
    }
    return isWithin(castNode, governing.elseStatement) ? false : null;
  }
  if (ts.isConditionalExpression(governing)) {
    if (isWithin(castNode, governing.whenTrue)) {
      return true;
    }
    return isWithin(castNode, governing.whenFalse) ? false : null;
  }
  return ts.isSwitchStatement(governing) ? null : true;
}

function yieldProvesTarget(typeChecker, yielded, targetType) {
  if (yielded === OBJECT_YIELD) {
    return (
      !typeChecker.isArrayLikeType(targetType) &&
      claimsOnlyUnknownValuedKeys(typeChecker, targetType)
    );
  }
  return narrowingProvesTarget(typeChecker, yielded, targetType);
}

function assertionProof(
  typeChecker,
  occurrence,
  governing,
  castNode,
  targetType
) {
  const tested = skipOuterParents(occurrence.node);
  const call = skipTransparentExpressions(governing.expression);
  const yielded =
    ts.isCallExpression(call) && predicateYield(typeChecker, call, tested);
  const established =
    yielded &&
    yielded.asserts &&
    navigateMembers(typeChecker, yielded.type, occurrence.remainder);
  return established &&
    yieldProvesTarget(typeChecker, established, targetType) &&
    governing.end <= castNode.getStart() &&
    isWithin(castNode, governing.parent)
    ? { node: governing, skipped: [] }
    : null;
}

function conditionGovernedProof(
  typeChecker,
  chain,
  governing,
  castNode,
  targetType
) {
  const condition = GOVERNING_CONDITION[governing.kind](governing);
  if (!condition) {
    return null;
  }
  const tests = conditionTests(
    typeChecker,
    chain,
    condition,
    castNode,
    targetType
  );
  if (!tests.size) {
    return null;
  }
  if (isWithin(castNode, condition)) {
    const proof = proofWithinCondition(condition, castNode, tests);
    return proof ? { node: proof.anchor, skipped: proof.skipped } : null;
  }
  if (governing.pos <= castNode.pos && governing.end >= castNode.end) {
    const required = outcomeReachingCast(governing, castNode);
    const proof =
      required !== null && conditionProof(condition, required, tests);
    return proof ? { node: proof.anchor, skipped: proof.skipped } : null;
  }
  if (!isEarlyExitGuard(governing, castNode)) {
    return null;
  }
  const proof = conditionProof(condition, false, tests);
  return proof
    ? {
        node: proof.anchor,
        skipped: [...proof.skipped, governing.thenStatement],
      }
    : null;
}

function proofPoint(typeChecker, chain, castNode, body, targetType) {
  let latest = null;
  const governed = new Set();
  const consider = (proof) => {
    if (proof && (!latest || proof.node.end > latest.node.end)) {
      latest = proof;
    }
  };
  for (const occurrence of referenceOccurrences(typeChecker, chain)) {
    const tested = skipOuterParents(occurrence.node);
    const governing = governingConstruct(tested);
    if (!governing || enclosingContainer(tested) !== body) {
      continue;
    }
    if (ts.isExpressionStatement(governing)) {
      consider(
        assertionProof(typeChecker, occurrence, governing, castNode, targetType)
      );
      continue;
    }
    if (governed.has(governing)) {
      continue;
    }
    governed.add(governing);
    consider(
      conditionGovernedProof(
        typeChecker,
        chain,
        governing,
        castNode,
        targetType
      )
    );
  }
  return latest;
}

function windowDisruption(typeChecker, chain, castNode, targetType) {
  const body = enclosingContainer(castNode);
  const loop = enclosingIterationStatement(castNode, body);
  const proof = proofPoint(typeChecker, chain, castNode, body, targetType);
  const windowStart = proof ? proof.node.end : body.pos;
  const proofRepeatsEachIteration = Boolean(
    loop && proof && proof.node.pos >= loop.pos
  );
  const windowEnd =
    loop && !proofRepeatsEachIteration
      ? Math.max(loop.end, castNode.end)
      : castNode.end;
  let disruption = null;
  function visit(node) {
    if (
      disruption ||
      node === castNode ||
      proof?.skipped.some(
        (span) => node.pos >= span.pos && node.end <= span.end
      ) ||
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
      !(
        ts.isCallExpression(node) &&
        callHasTypePredicate(typeChecker, node) &&
        callOperands(node).some((operand) =>
          isChainPrefixSpelling(typeChecker, operand, chain)
        )
      )
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
    : windowDisruption(
        typeChecker,
        chain,
        castNode,
        typeChecker.getTypeFromTypeNode(castNode.type)
      );
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
    .map((occurrence) => skipOuterParents(occurrence.node))
    .filter(
      (tested) =>
        executesBeforeCast(tested, castNode, loop) &&
        enclosingContainer(tested) === body
    )
    .flatMap(testConsumers);
}
