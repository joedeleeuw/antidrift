import ts from "typescript";
import {
  isAppeasementCastSourceType,
  isAppeasementCastTargetType,
  isNamedTypeReference,
} from "./broad-input.mjs";
import { EFFECT_DECODE_METHODS } from "./effect-schema.mjs";
import { ZOD_VALIDATION_METHODS } from "./schema-provenance.mjs";

const TYPE_FLAG_ANY = 1;
const TYPE_FLAG_UNKNOWN = 2;

export function expressionRoot(expression) {
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

export function sameReference(typeChecker, leftExpression, rightExpression) {
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

export function changesOperand(
  typeChecker,
  statementOrExpression,
  operandExpression
) {
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

export function statementAlwaysExits(statementNode) {
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

function isExpectationInstanceCheck(
  typeChecker,
  callExpression,
  operandExpression,
  targetType
) {
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
    !sameReference(typeChecker, expectationCall.arguments[0], operandExpression)
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

function hasTypePredicateSignature(
  typeChecker,
  callExpression,
  operandExpression,
  targetType
) {
  const signature = typeChecker.getResolvedSignature(callExpression);
  const typePredicate =
    signature && typeChecker.getTypePredicateOfSignature(signature);
  if (!typePredicate || !typePredicate.type) {
    return false;
  }
  const argumentForPredicate =
    callExpression.arguments[typePredicate.parameterIndex];
  return Boolean(
    argumentForPredicate &&
    sameReference(typeChecker, argumentForPredicate, operandExpression) &&
    isPredicateAssignableToTarget(typeChecker, typePredicate.type, targetType)
  );
}

function isCallTypePredicateProof(
  typeChecker,
  callExpression,
  operandExpression,
  targetType
) {
  if (!ts.isCallExpression(callExpression)) {
    return false;
  }
  if (
    hasTypePredicateSignature(
      typeChecker,
      callExpression,
      operandExpression,
      targetType
    )
  ) {
    return true;
  }
  if (
    ts.isIdentifier(callExpression.expression) &&
    ["assert", "invariant", "ok"].includes(callExpression.expression.text) &&
    callExpression.arguments.length >= 1
  ) {
    return conditionProvesTarget(
      typeChecker,
      callExpression.arguments[0],
      operandExpression,
      targetType,
      false
    );
  }
  return false;
}

function callConditionProvesTarget(
  typeChecker,
  callExpression,
  operandExpression,
  targetType
) {
  if (
    hasTypePredicateSignature(
      typeChecker,
      callExpression,
      operandExpression,
      targetType
    )
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(callExpression.expression) &&
    callExpression.expression.name.text === "has" &&
    callExpression.arguments.length === 1 &&
    sameReference(typeChecker, callExpression.arguments[0], operandExpression)
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

function instanceOfConditionProvesTarget(
  typeChecker,
  binaryExpression,
  operandExpression,
  targetType
) {
  if (
    binaryExpression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    sameReference(typeChecker, binaryExpression.left, operandExpression)
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

function resolveInitializerCall(typeChecker, expressionNode) {
  const unwrapped = expressionRoot(expressionNode);
  if (ts.isCallExpression(unwrapped)) {
    return unwrapped;
  }
  if (!ts.isIdentifier(unwrapped)) {
    return null;
  }
  const symbol = typeChecker.getSymbolAtLocation(unwrapped);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initNode = expressionRoot(declaration.initializer);
      if (ts.isCallExpression(initNode)) {
        return initNode;
      }
    }
  }
  return null;
}

function conditionProvesTarget(
  typeChecker,
  conditionExpression,
  operandExpression,
  targetType,
  negated
) {
  const unwrappedCondition = expressionRoot(conditionExpression);
  if (!unwrappedCondition) {
    return false;
  }

  if (
    ts.isPrefixUnaryExpression(unwrappedCondition) &&
    unwrappedCondition.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return conditionProvesTarget(
      typeChecker,
      unwrappedCondition.operand,
      operandExpression,
      targetType,
      !negated
    );
  }

  if (ts.isBinaryExpression(unwrappedCondition)) {
    if (
      (!negated &&
        unwrappedCondition.operatorToken.kind ===
          ts.SyntaxKind.AmpersandAmpersandToken) ||
      (negated &&
        unwrappedCondition.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return (
        conditionProvesTarget(
          typeChecker,
          unwrappedCondition.left,
          operandExpression,
          targetType,
          negated
        ) ||
        conditionProvesTarget(
          typeChecker,
          unwrappedCondition.right,
          operandExpression,
          targetType,
          negated
        )
      );
    }
    if (!negated) {
      return instanceOfConditionProvesTarget(
        typeChecker,
        unwrappedCondition,
        operandExpression,
        targetType
      );
    }
  }

  if (negated) {
    return false;
  }

  if (ts.isCallExpression(unwrappedCondition)) {
    return callConditionProvesTarget(
      typeChecker,
      unwrappedCondition,
      operandExpression,
      targetType
    );
  }

  if (
    ts.isPropertyAccessExpression(unwrappedCondition) &&
    unwrappedCondition.name.text === "success"
  ) {
    const safeParseCall = resolveInitializerCall(
      typeChecker,
      unwrappedCondition.expression
    );
    return Boolean(
      safeParseCall &&
      isPrecedingStatementSchemaDecode(
        typeChecker,
        safeParseCall,
        operandExpression,
        targetType
      )
    );
  }

  return false;
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

function isExpectationNonNullCheck(
  typeChecker,
  callExpression,
  operandExpression,
  sourceType,
  targetType
) {
  const nonNullableSourceType = typeChecker.getNonNullableType(sourceType);
  if (!typeChecker.isTypeAssignableTo(nonNullableSourceType, targetType)) {
    return false;
  }
  if (
    !ts.isCallExpression(callExpression) ||
    !ts.isPropertyAccessExpression(callExpression.expression)
  ) {
    return false;
  }
  const memberAccess = callExpression.expression;
  const matcherName = memberAccess.name.text;
  let subjectCall = memberAccess.expression;
  if (
    ts.isPropertyAccessExpression(subjectCall) &&
    subjectCall.name.text === "not"
  ) {
    if (["toBeNull", "toBeUndefined", "toBeFalsy"].includes(matcherName)) {
      subjectCall = subjectCall.expression;
    } else {
      return false;
    }
  } else if (!["toBeDefined", "toBeTruthy"].includes(matcherName)) {
    return false;
  }

  return Boolean(
    ts.isCallExpression(subjectCall) &&
    ts.isIdentifier(subjectCall.expression) &&
    subjectCall.arguments.length === 1 &&
    sameReference(typeChecker, subjectCall.arguments[0], operandExpression)
  );
}

function isPrecedingStatementSchemaDecode(
  typeChecker,
  callExpression,
  operandExpression,
  targetType
) {
  if (
    !ts.isCallExpression(callExpression) ||
    callExpression.arguments.length < 1 ||
    !sameReference(typeChecker, callExpression.arguments[0], operandExpression)
  ) {
    return false;
  }
  const callee = callExpression.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ZOD_VALIDATION_METHODS.has(callee.name.text)
  ) {
    return true;
  }
  const signature = typeChecker.getResolvedSignature(callExpression);
  if (!signature || signature.parameters.length < 1) {
    return false;
  }
  const parameterType = typeChecker.getTypeOfSymbolAtLocation(
    signature.parameters[0],
    callExpression
  );
  if (!(parameterType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
    return false;
  }
  const returnType = typeChecker.getReturnTypeOfSignature(signature);
  return (
    !(
      returnType.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)
    ) && typeChecker.isTypeAssignableTo(returnType, targetType)
  );
}

function isCallDecodeExpression(typeChecker, candidateCall, targetType) {
  if (ts.isPropertyAccessExpression(candidateCall.expression)) {
    const methodName = candidateCall.expression.name.text;
    if (
      ZOD_VALIDATION_METHODS.has(methodName) ||
      ["validate", "validateSync", "isValidSync"].includes(methodName)
    ) {
      return true;
    }
  }
  if (ts.isCallExpression(candidateCall.expression)) {
    const innerCall = candidateCall.expression;
    if (
      ts.isPropertyAccessExpression(innerCall.expression) &&
      EFFECT_DECODE_METHODS.has(innerCall.expression.name.text)
    ) {
      return true;
    }
  }
  const signature = typeChecker.getResolvedSignature(candidateCall);
  if (!signature || signature.parameters.length < 1) {
    return false;
  }
  const parameterType = typeChecker.getTypeOfSymbolAtLocation(
    signature.parameters[0],
    candidateCall
  );
  if (!(parameterType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
    return false;
  }
  const returnType = typeChecker.getReturnTypeOfSignature(signature);
  return (
    !(
      returnType.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)
    ) && typeChecker.isTypeAssignableTo(returnType, targetType)
  );
}

function isInitializedBySchemaDecode(
  typeChecker,
  operandExpression,
  targetType
) {
  const unwrappedOperand = expressionRoot(operandExpression);
  if (!unwrappedOperand || !ts.isIdentifier(unwrappedOperand)) {
    return false;
  }
  const operandSymbol = typeChecker.getSymbolAtLocation(unwrappedOperand);
  for (const declaration of operandSymbol?.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      continue;
    }
    let candidateCall = expressionRoot(declaration.initializer);
    if (ts.isAwaitExpression(candidateCall)) {
      candidateCall = expressionRoot(candidateCall.expression);
    }
    if (
      ts.isCallExpression(candidateCall) &&
      isCallDecodeExpression(typeChecker, candidateCall, targetType)
    ) {
      return true;
    }
  }
  return false;
}

function checkEnclosingBranchProof(
  typeChecker,
  parentNode,
  childNode,
  operandExpression,
  targetType
) {
  if (changesOperand(typeChecker, childNode, operandExpression)) {
    return null;
  }
  if (ts.isIfStatement(parentNode)) {
    if (
      parentNode.thenStatement === childNode &&
      conditionProvesTarget(
        typeChecker,
        parentNode.expression,
        operandExpression,
        targetType,
        false
      )
    ) {
      return "branch_guard";
    }
    if (
      parentNode.elseStatement === childNode &&
      conditionProvesTarget(
        typeChecker,
        parentNode.expression,
        operandExpression,
        targetType,
        true
      )
    ) {
      return "branch_guard";
    }
  }
  if (ts.isConditionalExpression(parentNode)) {
    if (
      parentNode.whenTrue === childNode &&
      conditionProvesTarget(
        typeChecker,
        parentNode.condition,
        operandExpression,
        targetType,
        false
      )
    ) {
      return "branch_guard";
    }
    if (
      parentNode.whenFalse === childNode &&
      conditionProvesTarget(
        typeChecker,
        parentNode.condition,
        operandExpression,
        targetType,
        true
      )
    ) {
      return "branch_guard";
    }
  }
  if (
    ts.isBinaryExpression(parentNode) &&
    parentNode.right === childNode &&
    parentNode.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    conditionProvesTarget(
      typeChecker,
      parentNode.left,
      operandExpression,
      targetType,
      false
    )
  ) {
    return "branch_guard";
  }
  return null;
}

function checkPrecedingStatementProof(
  typeChecker,
  priorStatement,
  operandExpression,
  sourceType,
  targetType
) {
  if (
    ts.isIfStatement(priorStatement) &&
    !priorStatement.elseStatement &&
    statementAlwaysExits(priorStatement.thenStatement) &&
    conditionProvesTarget(
      typeChecker,
      priorStatement.expression,
      operandExpression,
      targetType,
      true
    )
  ) {
    return "early_exit_guard";
  }
  if (!ts.isExpressionStatement(priorStatement)) {
    return null;
  }
  const expression = priorStatement.expression;
  if (
    isExpectationInstanceCheck(
      typeChecker,
      expression,
      operandExpression,
      targetType
    )
  ) {
    return "instance_check";
  }
  const expectationCondition = extractExpectationTrueCondition(expression);
  if (
    expectationCondition &&
    conditionProvesTarget(
      typeChecker,
      expectationCondition,
      operandExpression,
      targetType,
      false
    )
  ) {
    return "condition_check";
  }
  if (
    isExpectationNonNullCheck(
      typeChecker,
      expression,
      operandExpression,
      sourceType,
      targetType
    )
  ) {
    return "non_null_check";
  }
  if (
    isCallTypePredicateProof(
      typeChecker,
      expression,
      operandExpression,
      targetType
    )
  ) {
    return "type_predicate";
  }
  if (
    isPrecedingStatementSchemaDecode(
      typeChecker,
      expression,
      operandExpression,
      targetType
    )
  ) {
    return "schema_decode";
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

export function findDominatingProof(
  typeChecker,
  assertionNode,
  operandExpression,
  sourceType,
  targetType
) {
  if (isInitializedBySchemaDecode(typeChecker, operandExpression, targetType)) {
    return "schema_decode";
  }

  for (
    let currentNode = assertionNode;
    currentNode.parent && !ts.isFunctionLike(currentNode.parent);
    currentNode = currentNode.parent
  ) {
    const parentNode = currentNode.parent;
    const branchProof = checkEnclosingBranchProof(
      typeChecker,
      parentNode,
      currentNode,
      operandExpression,
      targetType
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
      if (changesOperand(typeChecker, priorStatement, operandExpression)) {
        return null;
      }
      const proofKind = checkPrecedingStatementProof(
        typeChecker,
        priorStatement,
        operandExpression,
        sourceType,
        targetType
      );
      if (proofKind) {
        return proofKind;
      }
    }
  }

  return null;
}

export function buildCastEvaluationContext(
  castNode,
  parserServices,
  typeChecker
) {
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

  return {
    castNode,
    tsExpression,
    tsTypeNode,
    tsAssertion,
    sourceType,
    targetType,
    typeChecker,
    parserServices,
  };
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

export const CAST_DECISION_TABLE = [
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
    rationale: "Cast inside a type predicate function implementing the guard.",
    matches: ({ castNode }) => {
      let ancestorNode = castNode.parent;
      while (ancestorNode) {
        if (
          [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
          ].includes(ancestorNode.type)
        ) {
          return (
            ancestorNode.returnType?.typeAnnotation?.type === "TSTypePredicate"
          );
        }
        ancestorNode = ancestorNode.parent;
      }
      return false;
    },
  },
  {
    decisionKind: "unnamed_target_contract",
    resolutionAction: "clear",
    rationale: "Target is not a named type reference to a contract.",
    matches: ({ castNode }) => !isNamedTypeReference(castNode.typeAnnotation),
  },
  {
    decisionKind: "non_broad_source",
    resolutionAction: "clear",
    rationale: "Resolved source type is not any or unknown.",
    matches: ({ sourceType, typeChecker }) =>
      !isCompilerErrorType(typeChecker, sourceType) &&
      !isAppeasementCastSourceType(sourceType),
  },
  {
    decisionKind: "untyped_or_empty_target",
    resolutionAction: "clear",
    rationale:
      "Resolved target has no declared object contract properties or is an antidrift branded type.",
    matches: ({ targetType, typeChecker }) =>
      !isCompilerErrorType(typeChecker, targetType) &&
      !isAppeasementCastTargetType(targetType),
  },
  {
    decisionKind: "dominating_runtime_proof",
    resolutionAction: "clear",
    rationale: "Preceding runtime assertion or decode proves the target type.",
    matches: ({
      typeChecker,
      tsAssertion,
      tsExpression,
      sourceType,
      targetType,
    }) => {
      if (
        !tsAssertion ||
        !tsExpression ||
        isCompilerErrorType(typeChecker, sourceType) ||
        isCompilerErrorType(typeChecker, targetType)
      ) {
        return false;
      }
      return Boolean(
        findDominatingProof(
          typeChecker,
          tsAssertion,
          tsExpression,
          sourceType,
          targetType
        )
      );
    },
  },
  {
    decisionKind: "unresolved_type_analysis",
    resolutionAction: "incomplete",
    rationale: "TypeScript compiler could not resolve source or target type.",
    matches: ({
      tsExpression,
      tsTypeNode,
      sourceType,
      targetType,
      typeChecker,
    }) =>
      !tsExpression ||
      !tsTypeNode ||
      isCompilerErrorType(typeChecker, sourceType) ||
      isCompilerErrorType(typeChecker, targetType),
  },
  {
    decisionKind: "broad_source_to_named_contract",
    resolutionAction: "report",
    rationale:
      "Casting any or unknown into a named object contract without preceding proof.",
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
      };
    }
  }
  throw new Error("Unreachable: CAST_DECISION_TABLE is exhaustive.");
}
