import {
  checkRedundantUnknownHelper,
  isAliasedRawDeserialize,
  isRawDeserializeCall,
} from "./boundary-decode-checks.js";
import { topLevelTypeDeclarations } from "./type-predicate-checks.js";
import {
  classifyWideningTarget,
  createTypeEnvironment,
  isKnownEvidenceExpression,
} from "../shared/dictionary-types.js";
import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  closedStringLiteralUnionValues,
  getResolvedType,
  getTypeServices,
  hasTypeChecker,
  isBroadResolvedType,
} from "../shared/type-services.js";
import {
  findVariable,
  nearestFunction,
  unwrapExpression,
} from "../shared/scope.js";

function bindingDeclarator(binding) {
  if (binding.defs.length !== 1) return null;
  const [definition] = binding.defs;
  return definition?.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function isStableConstBinding(binding, declarator) {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    binding.references.every(
      (reference) => reference.init || !reference.isWrite()
    )
  );
}

function isNullishExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    (unwrapped.type === "Literal" && unwrapped.value === null) ||
    (unwrapped.type === "Identifier" && unwrapped.name === "undefined") ||
    (unwrapped.type === "UnaryExpression" && unwrapped.operator === "void")
  );
}

function isCatchClauseIdentifier(sourceCode, expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    unwrapped.type === "Identifier" &&
    findVariable(sourceCode, unwrapped)?.defs?.[0]?.type === "CatchClause"
  );
}

function hasConcreteStaticType(sourceCode, expression) {
  const services = getTypeServices(sourceCode);
  if (
    !services ||
    isNullishExpression(expression) ||
    isRawDeserializeCall(expression, sourceCode) ||
    isAliasedRawDeserialize(expression, sourceCode) ||
    isCatchClauseIdentifier(sourceCode, expression)
  ) {
    return false;
  }
  const unwrapped = unwrapExpression(expression);
  if (isBroadResolvedType(unwrapped, sourceCode)) return false;
  const resolved = getResolvedType(unwrapped, sourceCode);
  if (!resolved) return false;
  if (
    ((resolved.flags ?? 0) & (1 | 2 | 16_384 | 32_768 | 65_536 | 131_072)) !==
    0
  ) {
    return false;
  }
  const text = services.checker.typeToString(resolved);
  return !/^(?:readonly\s+)?(?:unknown|any)\[\]$/u.test(text);
}

function hasKnownEvidence(
  sourceCode,
  expression,
  destination = null,
  visitedBindings = new Set()
) {
  if (isKnownEvidenceExpression(expression)) return true;
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "Identifier") {
    const binding = findVariable(sourceCode, unwrapped);
    if (binding !== null && !visitedBindings.has(binding)) {
      const declarator = bindingDeclarator(binding);
      if (
        declarator !== null &&
        declarator.init !== null &&
        isStableConstBinding(binding, declarator)
      ) {
        visitedBindings.add(binding);
        if (
          hasKnownEvidence(
            sourceCode,
            declarator.init,
            destination,
            visitedBindings
          )
        ) {
          return true;
        }
      }
    }
  }
  return (
    destination?.kind !== "anonymous object" &&
    hasConcreteStaticType(sourceCode, expression)
  );
}

function annotationTarget(annotation, environment) {
  return annotation === null || annotation === undefined
    ? null
    : classifyWideningTarget(annotation.typeAnnotation, environment);
}

function sourceKeyName(sourceCode, key) {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") {
    return key.name;
  }
  if (key.type === "Literal") return String(key.value);
  return sourceCode.getText(key);
}

function functionName(sourceCode, owner) {
  if (owner === null) return "anonymous function";
  if (owner.id !== null) return owner.id.name;
  const parent = owner.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "MethodDefinition") {
    return sourceKeyName(sourceCode, parent.key);
  }
  return "anonymous function";
}

function isEmptyCollectionExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    (unwrapped.type === "ObjectExpression" &&
      unwrapped.properties.length === 0) ||
    (unwrapped.type === "ArrayExpression" && unwrapped.elements.length === 0)
  );
}

function isAccumulatorTarget(destination) {
  return (
    destination.kind === "open dictionary" ||
    destination.kind === "generic container" ||
    destination.kind === "unknown"
  );
}

function hasParentAssertion(node) {
  return (
    node.parent?.type === "TSAsExpression" ||
    node.parent?.type === "TSTypeAssertion"
  );
}

function shouldReportUntypedAssertion(sourceCode, node, destination) {
  return (
    !hasTypeChecker(sourceCode) &&
    !isRawDeserializeCall(node.expression, sourceCode) &&
    !isAliasedRawDeserialize(node.expression, sourceCode) &&
    !isCatchClauseIdentifier(sourceCode, node.expression) &&
    (destination.kind === "object" ||
      node.typeAnnotation.type === "TSArrayType")
  );
}

function canReportFlow(sourceCode, expression, destination) {
  if (destination === null) return false;
  if (destination.kind === "unknown" && isNullishExpression(expression)) {
    return false;
  }
  if (
    isAccumulatorTarget(destination) &&
    isEmptyCollectionExpression(expression)
  ) {
    return false;
  }
  return hasKnownEvidence(sourceCode, expression, destination);
}

function createFlowReporter(context, getEnvironment) {
  const reportFlow = (expression, destination, subject) => {
    if (!canReportFlow(context.sourceCode, expression, destination)) {
      return false;
    }
    context.report({
      node: expression,
      messageId: "widening",
      data: { subject, target: destination.kind },
    });
    return true;
  };
  const targetFromAnnotation = (annotation) => {
    const environment = getEnvironment();
    return environment ? annotationTarget(annotation, environment) : null;
  };
  const reportProperty = (node) => {
    if (node.value === null) return;
    reportFlow(
      node.value,
      targetFromAnnotation(node.typeAnnotation),
      `property \`${sourceKeyName(context.sourceCode, node.key)}\``
    );
  };
  const reportAssertion = (node) => {
    const environment = getEnvironment();
    if (environment === null || hasParentAssertion(node)) return;
    const destination = classifyWideningTarget(
      node.typeAnnotation,
      environment
    );
    if (!destination) return;
    if (shouldReportUntypedAssertion(context.sourceCode, node, destination)) {
      context.report({
        node: node.expression,
        messageId: "widening",
        data: { subject: "assertion", target: destination.kind },
      });
      return;
    }
    reportFlow(node.expression, destination, "assertion");
  };
  return {
    reportFlow,
    targetFromAnnotation,
    reportProperty,
    reportAssertion,
  };
}

function createKnownValueWideningVisitors(context) {
  let environment = null;
  const reportedFunctions = new WeakSet();
  const { reportFlow, targetFromAnnotation, reportProperty, reportAssertion } =
    createFlowReporter(context, () => environment);
  return {
    Program(node) {
      environment = createTypeEnvironment(node, context.sourceCode);
    },
    VariableDeclarator(node) {
      if (node.init === null || node.id.type !== "Identifier") return;
      const target = targetFromAnnotation(node.id.typeAnnotation);
      reportFlow(node.init, target, `binding \`${node.id.name}\``);
    },
    PropertyDefinition: reportProperty,
    AccessorProperty: reportProperty,
    AssignmentExpression(node) {
      if (node.operator !== "=" || node.left.type !== "Identifier") return;
      const binding = findVariable(context.sourceCode, node.left);
      const declarator = binding ? bindingDeclarator(binding) : null;
      if (declarator === null || declarator.id.type !== "Identifier") return;
      const target = targetFromAnnotation(declarator.id.typeAnnotation);
      reportFlow(node.right, target, `binding \`${declarator.id.name}\``);
    },
    ReturnStatement(node) {
      if (node.argument === null) return;
      const owner = nearestFunction(node);
      if (owner && reportedFunctions.has(owner)) return;
      const label = `return value of \`${functionName(context.sourceCode, owner)}\``;
      if (
        reportFlow(
          node.argument,
          targetFromAnnotation(owner?.returnType),
          label
        ) &&
        owner
      ) {
        reportedFunctions.add(owner);
      }
    },
    ArrowFunctionExpression(node) {
      if (node.body.type === "BlockStatement") return;
      const label = `return value of \`${functionName(context.sourceCode, node)}\``;
      reportFlow(node.body, targetFromAnnotation(node.returnType), label);
    },
    TSAsExpression: reportAssertion,
    TSTypeAssertion: reportAssertion,
  };
}

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function unwrapExpressionParentheses(expression) {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

function unwrapTypeParentheses(type) {
  let current = type;
  while (current.type === "TSParenthesizedType") {
    current = current.typeAnnotation;
  }
  return current;
}

function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isUnknownOrAnyType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  return (
    unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword"
  );
}

function isBroadRecordKeyType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every(isBroadRecordKeyType);
  }
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === "PropertyKey"
  );
}

function isBroadRecordType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeReference") {
    if (typeReferenceName(unwrapped) === "Readonly") {
      const [inner] = unwrapped.typeArguments?.params ?? [];
      return inner !== undefined && isBroadRecordType(inner);
    }
    if (typeReferenceName(unwrapped) !== "Record") return false;
    const typeArguments = unwrapped.typeArguments?.params ?? [];
    return (
      typeArguments.length === 2 &&
      typeArguments[0] !== undefined &&
      typeArguments[1] !== undefined &&
      isBroadRecordKeyType(typeArguments[0]) &&
      isUnknownOrAnyType(typeArguments[1])
    );
  }
  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) {
    return false;
  }
  const [member] = unwrapped.members;
  const [parameter] =
    member?.type === "TSIndexSignature" ? member.parameters : [];
  return (
    member?.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    parameter !== undefined &&
    isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

function broadTypeKind(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    unwrapped.type === "TSUnknownKeyword" ||
    unwrapped.type === "TSAnyKeyword"
  ) {
    return "top";
  }
  if (unwrapped.type === "TSObjectKeyword") return "object";
  return isBroadRecordType(unwrapped) ? "record" : null;
}

function assertedExpression(node) {
  return unwrapExpressionParentheses(node.expression);
}

function assertionFromExpression(expression) {
  const unwrapped = unwrapExpressionParentheses(expression);
  return unwrapped.type === "TSAsExpression" ||
    unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

function startOf(node) {
  return node.range?.[0] ?? node.start;
}

function endOf(node) {
  return node.range?.[1] ?? node.end;
}

function normalizedTypeText(sourceText, type) {
  return sourceText.slice(startOf(type), endOf(type)).replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(sourceText, left, right) {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
      normalizedTypeText(sourceText, unwrapTypeParentheses(right))
  );
}

function isDefinitelyObjectType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  switch (unwrapped.type) {
    case "TSArrayType":
    case "TSConstructorType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return unwrapped.members.length > 0;
    case "TSIntersectionType":
      return unwrapped.types.every(isDefinitelyObjectType);
    case "TSTypeOperator":
      return (
        unwrapped.operator === "readonly" &&
        isDefinitelyObjectType(unwrapped.typeAnnotation)
      );
    default:
      return false;
  }
}

function isDefinitelyNarrowerRecordType(type) {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some(
      (member) => member.type !== "TSIndexSignature"
    );
  }
  if (unwrapped.type !== "TSTypeReference") return false;
  if (typeReferenceName(unwrapped) === "Readonly") {
    const [inner] = unwrapped.typeArguments?.params ?? [];
    return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
  }
  if (typeReferenceName(unwrapped) !== "Record") return false;
  const typeArguments = unwrapped.typeArguments?.params ?? [];
  return (
    typeArguments.length === 2 &&
    typeArguments[1] !== undefined &&
    !isUnknownOrAnyType(typeArguments[1])
  );
}

function functionBoundary(node) {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (functionBoundaryTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function resolvedBindingForIdentifier(scopes, identifier) {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        startOf(candidate.identifier) === startOf(identifier) &&
        endOf(candidate.identifier) === endOf(identifier)
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

const KNOWN_SYNTAX_EXPRESSIONS = new Set([
  "Literal",
  "TemplateLiteral",
  "ArrayExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
  "FunctionExpression",
  "NewExpression",
  "ObjectExpression",
]);

function identifierEvidence(identifier, context) {
  const { scopes, boundary, visitedBindings } = context;
  const binding = resolvedBindingForIdentifier(scopes, identifier);
  if (binding === null || visitedBindings.has(binding)) return null;
  const annotatedIdentifier = binding.identifiers.find(
    (candidate) =>
      candidate.typeAnnotation !== null &&
      candidate.typeAnnotation !== undefined
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotatedIdentifier !== undefined) {
    return functionBoundary(annotatedIdentifier) === boundary &&
      broadTypeKind(annotation) === null
      ? { type: annotation }
      : null;
  }
  const declarator = bindingDeclarator(binding);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.init === null ||
    binding.references.some(
      (reference) => reference.isWrite() && !reference.init
    ) ||
    functionBoundary(declarator) !== boundary
  ) {
    return null;
  }
  return knownValueEvidence(declarator.init, {
    scopes,
    boundary,
    visitedBindings: new Set([...visitedBindings, binding]),
  });
}

function knownValueEvidence(expression, context) {
  const unwrapped = unwrapExpressionParentheses(expression);
  if (
    unwrapped.type === "TSAsExpression" ||
    unwrapped.type === "TSTypeAssertion"
  ) {
    return broadTypeKind(unwrapped.typeAnnotation) === null
      ? { type: unwrapped.typeAnnotation }
      : null;
  }
  if (KNOWN_SYNTAX_EXPRESSIONS.has(unwrapped.type)) {
    return { type: null };
  }
  return unwrapped.type === "Identifier"
    ? identifierEvidence(unwrapped, context)
    : null;
}

function widenedBinding(binding, scopes) {
  const declarator = bindingDeclarator(binding);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    binding.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  ) {
    return null;
  }
  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null
      ? null
      : broadTypeKind(initializerAssertion.typeAnnotation);
  const declaredBroadKind =
    declaredType === undefined ? null : broadTypeKind(declaredType);
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;
  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? assertedExpression(initializerAssertion)
      : declarator.init;
  const evidence = knownValueEvidence(originalExpression, {
    scopes,
    boundary,
    visitedBindings: new Set([binding]),
  });
  return evidence === null
    ? null
    : { broadKind, evidence, declaredAt: endOf(declarator), boundary };
}

function assertionIsNarrower(widened, assertedType, sourceText) {
  if (broadTypeKind(assertedType) !== null) return false;
  if (widened.broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, widened.evidence.type, assertedType)) {
    return true;
  }
  if (widened.broadKind === "object") {
    return isDefinitelyObjectType(assertedType);
  }
  return isDefinitelyNarrowerRecordType(assertedType);
}

function createWidenThenAssertVisitors(context) {
  let scopes = [];
  const checkAssertion = (node) => {
    const expression = assertedExpression(node);
    if (expression.type !== "Identifier") return;
    const binding = resolvedBindingForIdentifier(scopes, expression);
    if (binding === null) return;
    const widened = widenedBinding(binding, scopes);
    if (
      widened === null ||
      startOf(node) <= widened.declaredAt ||
      functionBoundary(node) !== widened.boundary ||
      !assertionIsNarrower(
        widened,
        node.typeAnnotation,
        context.sourceCode.text
      )
    ) {
      return;
    }
    context.report({
      node,
      messageId: "widenThenAssert",
      data: { name: expression.name },
    });
  };
  return {
    Program() {
      scopes = context.sourceCode.scopeManager.scopes;
    },
    TSAsExpression: checkAssertion,
    TSTypeAssertion: checkAssertion,
  };
}

function isAsUnknownExpression(node) {
  return (
    (node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion") &&
    node.typeAnnotation?.type === "TSUnknownKeyword"
  );
}

function isUnknownOrAnyAnnotation(typeAnnotation) {
  const inner = typeAnnotation?.typeAnnotation;
  return inner?.type === "TSUnknownKeyword" || inner?.type === "TSAnyKeyword";
}

function rootIdentifierOf(expr) {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped?.type === "Identifier") return unwrapped;
  if (
    unwrapped?.type === "MemberExpression" &&
    unwrapped.object?.type === "Identifier"
  ) {
    return unwrapped.object;
  }
  return null;
}

function hasKnownAnnotation(identifiers) {
  for (const ident of identifiers ?? []) {
    if (
      ident.typeAnnotation &&
      !isUnknownOrAnyAnnotation(ident.typeAnnotation)
    ) {
      return true;
    }
  }
  return false;
}

function constInitOfVariable(binding) {
  const def = binding?.defs?.[0];
  if (def?.type !== "Variable") return null;
  const decl = def.node;
  if (decl?.type !== "VariableDeclarator" || decl.parent?.kind !== "const") {
    return null;
  }
  if (isUnknownOrAnyAnnotation(decl.id?.typeAnnotation)) return null;
  return decl.init ?? null;
}

function isContractFreeLiteral(expr) {
  const unwrapped = unwrapExpression(expr);
  return (
    (unwrapped?.type === "ObjectExpression" &&
      unwrapped.properties.length === 0) ||
    (unwrapped?.type === "ArrayExpression" && unwrapped.elements.length === 0)
  );
}

function hasKnownValueOrigin(sourceCode, expr, seen = new Set()) {
  if (!expr) return false;
  if (isKnownEvidenceExpression(expr)) return !isContractFreeLiteral(expr);
  const rootIdent = rootIdentifierOf(expr);
  if (!rootIdent) return false;
  const binding = findVariable(sourceCode, rootIdent);
  if (!binding || seen.has(binding)) return false;
  seen.add(binding);
  if (hasKnownAnnotation(binding.identifiers)) return true;
  const init = constInitOfVariable(binding);
  return init ? hasKnownValueOrigin(sourceCode, init, seen) : false;
}

function erasedUnknownInitializer(sourceCode, node) {
  if (isAsUnknownExpression(node.init)) {
    const inner = node.init.expression;
    return isContractFreeLiteral(inner) ? null : inner;
  }
  if (node.id?.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword") {
    return hasKnownValueOrigin(sourceCode, node.init) ? node.init : null;
  }
  return null;
}

function isReestablishingRef(ident) {
  const parent = ident.parent;
  if (
    parent?.type === "TSAsExpression" &&
    parent.expression === ident &&
    parent.typeAnnotation?.type === "TSTypeReference"
  ) {
    return true;
  }
  if (
    parent?.type === "CallExpression" &&
    parent.arguments[0] === ident &&
    parent.callee?.type === "MemberExpression" &&
    parent.callee.property?.type === "Identifier" &&
    /^(?:parse|safeParse|parseAsync|decodeUnknownSync|decodeUnknownEither)$/u.test(
      parent.callee.property.name
    )
  ) {
    return true;
  }
  return false;
}

function checkErasedUnknownReparse(node, context) {
  const sourceCode = context.sourceCode;
  if (node.id?.type !== "Identifier" || node.parent?.kind !== "const") {
    return false;
  }
  const binding = erasedUnknownInitializer(sourceCode, node)
    ? findVariable(sourceCode, node.id)
    : null;
  if (
    binding?.references.some(
      (ref) => ref.isRead() && isReestablishingRef(ref.identifier)
    )
  ) {
    context.report({
      node: node.id,
      message:
        "Appeasement erasure: widening a known value to `unknown` only makes the parse or cast below look earned. Keep the precise type and validate at the real boundary.",
    });
    return true;
  }
  return false;
}

function isClosedKeyType(keyType, sourceCode, depth = 0) {
  if (
    keyType?.type === "TSLiteralType" ||
    (keyType?.type === "TSTypeOperator" && keyType.operator === "keyof") ||
    (keyType?.type === "TSUnionType" &&
      keyType.types.every((member) => member.type === "TSLiteralType"))
  ) {
    return true;
  }
  if (keyType?.type !== "TSTypeReference" || depth > 4) return false;
  const alias = topLevelTypeDeclarations(sourceCode.ast).get(
    keyType.typeName?.name
  )?.typeAnnotation;
  if (alias) return isClosedKeyType(alias, sourceCode, depth + 1);
  return (
    hasTypeChecker(sourceCode) &&
    (closedStringLiteralUnionValues(keyType, sourceCode)?.length ?? 0) > 0
  );
}

function isMemberWritten(identifier, sourceCode) {
  return (findVariable(sourceCode, identifier)?.references ?? []).some(
    (ref) => {
      const member = ref.identifier.parent;
      const write = member?.parent;
      return (
        member?.type === "MemberExpression" &&
        member.object === ref.identifier &&
        ((write?.type === "AssignmentExpression" && write.left === member) ||
          write?.type === "UpdateExpression" ||
          (write?.type === "UnaryExpression" && write.operator === "delete"))
      );
    }
  );
}

function checkCaseTableAnnotation(node, context) {
  const sourceCode = context.sourceCode;
  const annotation = node.id?.typeAnnotation?.typeAnnotation;
  const init = unwrapExpression(node.init);
  if (
    node.parent?.kind !== "const" ||
    node.id.type !== "Identifier" ||
    annotation?.type !== "TSTypeReference" ||
    annotation.typeName?.name !== "Record" ||
    init?.type !== "ObjectExpression" ||
    init.properties.length === 0 ||
    !isClosedKeyType(annotation.typeArguments?.params?.[0], sourceCode) ||
    isMemberWritten(node.id, sourceCode)
  ) {
    return;
  }
  const typeText = sourceCode.getText(annotation);
  context.report({
    node: node.id,
    message: `Case table '${node.id.name}' is annotated \`${typeText}\`, which erases each entry's own type; write \`{ ... } satisfies ${typeText}\` instead.`,
  });
}

function isDeclaratorAlreadyReported(node, sourceCode, reportedDeclarators) {
  const expr = unwrapExpression(node.expression);
  if (expr?.type !== "Identifier") return false;
  const declarator = findVariable(sourceCode, expr)?.defs?.[0]?.node;
  return Boolean(declarator && reportedDeclarators.has(declarator));
}

function createDeclaratorTrackingContext(
  context,
  reportedDeclarators,
  getCurrentDeclarator
) {
  return Object.create(context, {
    report: {
      value(descriptor) {
        const current = getCurrentDeclarator();
        if (current) reportedDeclarators.add(current);
        return context.report(descriptor);
      },
    },
  });
}

function referencedAliasName(type) {
  if (type.type === "TSParenthesizedType") {
    return referencedAliasName(type.typeAnnotation);
  }
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
    return null;
  }
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

function checkUnknownTypeAliases(programNode, context) {
  const aliases = new Map();
  for (const statement of programNode.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "TSTypeAliasDeclaration") {
      aliases.set(declaration.id.name, declaration);
    }
  }
  const resolvesToUnknown = (type, visited = new Set()) => {
    if (type.type === "TSUnknownKeyword") return true;
    if (type.type === "TSParenthesizedType") {
      return resolvesToUnknown(type.typeAnnotation, visited);
    }
    const name = referencedAliasName(type);
    if (name === null || visited.has(name)) return false;
    const alias = aliases.get(name);
    if (alias === undefined) {
      const resolved = getResolvedType(type, context.sourceCode);
      return ((resolved?.flags ?? 0) & 2) !== 0;
    }
    if (alias.typeParameters !== null && alias.typeParameters !== undefined) {
      return false;
    }
    return resolvesToUnknown(alias.typeAnnotation, new Set([...visited, name]));
  };
  for (const alias of aliases.values()) {
    if (resolvesToUnknown(alias.typeAnnotation, new Set([alias.id.name]))) {
      context.report({
        node: alias.id,
        messageId: "unknownAlias",
        data: { alias: alias.id.name },
      });
    }
  }
}

export const noAppeasementErasureRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow widening known values to broad/unknown types, `Record<ClosedKey, V>` case-table annotations, unknown type aliases, and unknown-error helpers applied to known errors.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      widening:
        "The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const reportedDeclarators = new WeakSet();
    const reportedAssertions = new WeakSet();
    let currentDeclarator = null;
    const trackingContext = createDeclaratorTrackingContext(
      context,
      reportedDeclarators,
      () => currentDeclarator
    );
    const widening = createKnownValueWideningVisitors(trackingContext);
    const widenThenAssert = createWidenThenAssertVisitors(context);
    const checkAssertion = (node) => {
      if (!reportedAssertions.has(node)) widening.TSAsExpression(node);
      if (
        !isDeclaratorAlreadyReported(
          node,
          context.sourceCode,
          reportedDeclarators
        )
      ) {
        widenThenAssert.TSAsExpression(node);
      }
    };

    return {
      ...widening,
      Program(node) {
        widening.Program(node);
        widenThenAssert.Program(node);
        checkUnknownTypeAliases(node, context);
      },
      CallExpression: (node) => checkRedundantUnknownHelper(node, context),
      VariableDeclarator(node) {
        checkCaseTableAnnotation(node, context);
        if (checkErasedUnknownReparse(node, context)) {
          reportedDeclarators.add(node);
          if (node.init) reportedAssertions.add(node.init);
          return;
        }
        currentDeclarator = node;
        widening.VariableDeclarator(node);
        currentDeclarator = null;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};
