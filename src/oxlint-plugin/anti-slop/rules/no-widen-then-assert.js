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

function bindingDeclarator(binding) {
  for (const definition of binding.defs) {
    if (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator"
    ) {
      return definition.node;
    }
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

export const noWidenThenAssertRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  create(context) {
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
  },
};
