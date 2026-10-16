import ts from "typescript";

import { scopeProperties } from "../../oxlint-plugin/portable/scope.js";
import { isTestFilename } from "../../oxlint-plugin/portable/syntax.js";
import {
  defineTypeScriptRule,
  resolveAliasedSymbol,
  symbolAtNode,
} from "../../semantic-adapters/ts-rule-kernel.mjs";

const NON_BAG_TYPE_NAMES = new Set([
  "AbortController",
  "AbortSignal",
  "Array",
  "ArrayBuffer",
  "Blob",
  "Buffer",
  "Checker",
  "CustomEvent",
  "DataView",
  "Date",
  "Document",
  "Element",
  "Error",
  "Event",
  "File",
  "FormData",
  "Function",
  "Headers",
  "HTMLElement",
  "Map",
  "Node",
  "Program",
  "Promise",
  "RangeError",
  "ReadableStream",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "ReferenceError",
  "RegExp",
  "Request",
  "Response",
  "RuleContext",
  "Set",
  "SharedArrayBuffer",
  "Signature",
  "SourceCode",
  "SourceFile",
  "Symbol",
  "SyntaxError",
  "TransformStream",
  "Type",
  "TypeChecker",
  "TypeError",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
  "Window",
  "WritableStream",
]);

const PRIMITIVE_COERCION_CALLEES = new Set(["Boolean", "Number", "String"]);

const ANONYMOUS_UTILITY_TYPE_NAMES = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Record",
  "Required",
]);

function unwrapExpression(expression) {
  let current = expression;
  while (current) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function isNullishExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return true;
  }
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    return true;
  }
  return (
    ts.isVoidExpression(unwrapped) &&
    ts.isNumericLiteral(unwrapped.expression) &&
    unwrapped.expression.text === "0"
  );
}

function isStaticScalarLiteral(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return false;
  }
  if (
    ts.isStringLiteralLike(unwrapped) ||
    ts.isNumericLiteral(unwrapped) ||
    ts.isBigIntLiteral(unwrapped) ||
    unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined")
  ) {
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(unwrapped) &&
    (unwrapped.operator === ts.SyntaxKind.MinusToken ||
      unwrapped.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(unwrapped.operand)
  );
}

function isEmptyObjectFallback(expression) {
  const unwrapped = unwrapExpression(expression);
  return (
    Boolean(unwrapped) &&
    ts.isObjectLiteralExpression(unwrapped) &&
    unwrapped.properties.length === 0
  );
}

function nonNullishTypeParts(candidateType) {
  const parts = candidateType.isUnion() ? candidateType.types : [candidateType];
  return parts.filter(
    (part) =>
      !(
        part.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)
      )
  );
}

function isPlainBagConstituentType(constituentType, checker) {
  if (
    constituentType.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.EnumLike |
      ts.TypeFlags.Never)
  ) {
    return false;
  }
  if (
    checker.isArrayType(constituentType) ||
    checker.isTupleType(constituentType) ||
    checker.getSignaturesOfType(constituentType, ts.SignatureKind.Call).length >
      0 ||
    checker.getSignaturesOfType(constituentType, ts.SignatureKind.Construct)
      .length > 0
  ) {
    return false;
  }
  const symbolName =
    constituentType.aliasSymbol?.escapedName ??
    constituentType.symbol?.escapedName ??
    "";
  if (NON_BAG_TYPE_NAMES.has(String(symbolName))) {
    return false;
  }
  if (
    constituentType.symbol &&
    Boolean(constituentType.symbol.flags & ts.SymbolFlags.Class)
  ) {
    return false;
  }
  const properties = checker.getPropertiesOfType(constituentType);
  if (
    properties.some((property) => {
      if (property.flags & ts.SymbolFlags.Method) {
        return true;
      }
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) {
        return false;
      }
      const propertyType = checker.getTypeOfSymbolAtLocation(
        property,
        declaration
      );
      return nonNullishTypeParts(propertyType).some(
        (part) =>
          checker.getSignaturesOfType(part, ts.SignatureKind.Call).length > 0
      );
    })
  ) {
    return false;
  }
  if (
    constituentType.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
  ) {
    return true;
  }
  if (!(constituentType.flags & ts.TypeFlags.Object)) {
    return false;
  }
  return (
    properties.length > 0 ||
    Boolean(checker.getIndexTypeOfType(constituentType, ts.IndexKind.String))
  );
}

function collectBindingPatternSymbols(bindingPattern, checker, symbolBucket) {
  for (const element of bindingPattern.elements) {
    if (element.dotDotDotToken) {
      return false;
    }
    if (
      element.initializer &&
      !isStaticScalarLiteral(element.initializer) &&
      !isEmptyObjectFallback(element.initializer)
    ) {
      return false;
    }
    if (ts.isIdentifier(element.name)) {
      const boundSymbol = resolveAliasedSymbol(
        checker,
        checker.getSymbolAtLocation(element.name)
      );
      if (!boundSymbol) {
        return false;
      }
      symbolBucket.add(boundSymbol);
      continue;
    }
    if (ts.isObjectBindingPattern(element.name)) {
      if (!collectBindingPatternSymbols(element.name, checker, symbolBucket)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function resolveBagParameter(functionNode, checker, sourceFile) {
  const valueParameters = functionNode.parameters.filter(
    (parameter) =>
      !(ts.isIdentifier(parameter.name) && parameter.name.text === "this")
  );
  if (valueParameters.length !== 1) {
    return null;
  }
  const parameter = valueParameters[0];
  if (
    parameter.dotDotDotToken ||
    ts.isArrayBindingPattern(parameter.name) ||
    (parameter.initializer &&
      !isEmptyObjectFallback(parameter.initializer) &&
      !isNullishExpression(parameter.initializer))
  ) {
    return null;
  }
  const parameterType = checker.getTypeAtLocation(parameter);
  const parts = nonNullishTypeParts(parameterType);
  if (
    parts.length === 0 ||
    !parts.every((part) => isPlainBagConstituentType(part, checker))
  ) {
    return null;
  }
  const bagRootSymbols = new Set();
  const bagFieldSymbols = new Set();
  if (ts.isIdentifier(parameter.name)) {
    const rootSymbol = resolveAliasedSymbol(
      checker,
      checker.getSymbolAtLocation(parameter.name)
    );
    if (!rootSymbol) {
      return null;
    }
    bagRootSymbols.add(rootSymbol);
    return {
      parameterName: parameter.name.text,
      bagRootSymbols,
      bagFieldSymbols,
    };
  }
  if (ts.isObjectBindingPattern(parameter.name)) {
    if (
      !collectBindingPatternSymbols(parameter.name, checker, bagFieldSymbols) ||
      bagFieldSymbols.size === 0
    ) {
      return null;
    }
    return {
      parameterName: parameter.name.getText(sourceFile).replace(/\s+/g, " "),
      bagRootSymbols,
      bagFieldSymbols,
    };
  }
  return null;
}

function isBagMemberChain(expression, bagState, checker) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return false;
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) ||
    (ts.isElementAccessExpression(unwrapped) &&
      isStaticScalarLiteral(unwrapped.argumentExpression))
  ) {
    if (
      ts.isPropertyAccessExpression(unwrapped) &&
      (unwrapped.name.text === "length" || unwrapped.name.text === "size")
    ) {
      return false;
    }
    const receiver = unwrapExpression(unwrapped.expression);
    if (ts.isIdentifier(receiver)) {
      const receiverSymbol = symbolAtNode(checker, receiver);
      return Boolean(
        receiverSymbol &&
        (bagState.bagRootSymbols.has(receiverSymbol) ||
          bagState.bagFieldSymbols.has(receiverSymbol))
      );
    }
    return isBagMemberChain(receiver, bagState, checker);
  }
  return false;
}

function isBagObjectReference(expression, bagState, checker) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return false;
  }
  if (ts.isIdentifier(unwrapped)) {
    const symbol = symbolAtNode(checker, unwrapped);
    return Boolean(
      symbol &&
      (bagState.bagRootSymbols.has(symbol) ||
        bagState.bagFieldSymbols.has(symbol))
    );
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    isEmptyObjectFallback(unwrapped.right)
  ) {
    return isBagObjectReference(unwrapped.left, bagState, checker);
  }
  return isBagMemberChain(unwrapped, bagState, checker);
}

function isPureBagCondition(expression, bagState, checker) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return false;
  }
  const valueCheck = inspectBagValueExpression(unwrapped, bagState, checker);
  if (valueCheck.valid) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return isPureBagCondition(unwrapped.operand, bagState, checker);
  }
  if (ts.isTypeOfExpression(unwrapped)) {
    return (
      isBagObjectReference(unwrapped.expression, bagState, checker) ||
      inspectBagValueExpression(unwrapped.expression, bagState, checker).valid
    );
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const operator = unwrapped.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      return (
        (isPureBagCondition(unwrapped.left, bagState, checker) ||
          isBagObjectReference(unwrapped.left, bagState, checker)) &&
        (isPureBagCondition(unwrapped.right, bagState, checker) ||
          isBagObjectReference(unwrapped.right, bagState, checker))
      );
    }
  }
  return false;
}

function inspectBagValueExpression(expression, bagState, checker) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return { valid: false, readsBagField: false };
  }
  if (isStaticScalarLiteral(unwrapped)) {
    return { valid: true, readsBagField: false };
  }
  if (ts.isIdentifier(unwrapped)) {
    const symbol = symbolAtNode(checker, unwrapped);
    if (symbol && bagState.bagFieldSymbols.has(symbol)) {
      return { valid: true, readsBagField: true };
    }
    return { valid: false, readsBagField: false };
  }
  if (isBagMemberChain(unwrapped, bagState, checker)) {
    return { valid: true, readsBagField: true };
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return inspectBagValueExpression(unwrapped.operand, bagState, checker);
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const operator = unwrapped.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const left = inspectBagValueExpression(unwrapped.left, bagState, checker);
      const right = inspectBagValueExpression(
        unwrapped.right,
        bagState,
        checker
      );
      return {
        valid: left.valid && right.valid,
        readsBagField: left.readsBagField || right.readsBagField,
      };
    }
    return { valid: false, readsBagField: false };
  }
  if (ts.isConditionalExpression(unwrapped)) {
    if (!isPureBagCondition(unwrapped.condition, bagState, checker)) {
      return { valid: false, readsBagField: false };
    }
    const whenTrue = inspectBagValueExpression(
      unwrapped.whenTrue,
      bagState,
      checker
    );
    const whenFalse = inspectBagValueExpression(
      unwrapped.whenFalse,
      bagState,
      checker
    );
    return {
      valid: whenTrue.valid && whenFalse.valid,
      readsBagField: whenTrue.readsBagField || whenFalse.readsBagField,
    };
  }
  if (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    PRIMITIVE_COERCION_CALLEES.has(unwrapped.expression.text) &&
    unwrapped.arguments.length === 1
  ) {
    const argumentCheck = inspectBagValueExpression(
      unwrapped.arguments[0],
      bagState,
      checker
    );
    return {
      valid: argumentCheck.valid && argumentCheck.readsBagField,
      readsBagField: argumentCheck.readsBagField,
    };
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    const nested = inspectObjectLiteralBagProjection(
      unwrapped,
      bagState,
      checker
    );
    return { valid: nested, readsBagField: nested };
  }
  return { valid: false, readsBagField: false };
}

function inspectObjectLiteralBagProjection(objectLiteral, bagState, checker) {
  if (objectLiteral.properties.length === 0) {
    return false;
  }
  let bagFieldReadCount = 0;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (!isBagObjectReference(property.expression, bagState, checker)) {
        return false;
      }
      bagFieldReadCount += 1;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (
        property.objectAssignmentInitializer &&
        !isStaticScalarLiteral(property.objectAssignmentInitializer)
      ) {
        return false;
      }
      const symbol = symbolAtNode(checker, property.name);
      if (!symbol || !bagState.bagFieldSymbols.has(symbol)) {
        return false;
      }
      bagFieldReadCount += 1;
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      if (
        ts.isComputedPropertyName(property.name) &&
        !isStaticScalarLiteral(property.name.expression)
      ) {
        return false;
      }
      const valueCheck = inspectBagValueExpression(
        property.initializer,
        bagState,
        checker
      );
      if (!valueCheck.valid) {
        return false;
      }
      if (valueCheck.readsBagField) {
        bagFieldReadCount += 1;
      }
      continue;
    }
    return false;
  }
  return bagFieldReadCount >= 1;
}

function collectReturnExpressionsFromExpression(expression, returnBucket) {
  if (!expression || isNullishExpression(expression)) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return collectReturnExpressionsFromExpression(
      expression.expression,
      returnBucket
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      collectReturnExpressionsFromExpression(
        expression.whenTrue,
        returnBucket
      ) &&
      collectReturnExpressionsFromExpression(expression.whenFalse, returnBucket)
    );
  }
  returnBucket.push(expression);
  return true;
}

function collectStatementReturnExpressions(
  statement,
  bagState,
  checker,
  returnBucket
) {
  if (ts.isBlock(statement)) {
    for (const childStatement of statement.statements) {
      if (
        !collectStatementReturnExpressions(
          childStatement,
          bagState,
          checker,
          returnBucket
        )
      ) {
        return false;
      }
    }
    return true;
  }
  if (ts.isReturnStatement(statement)) {
    return collectReturnExpressionsFromExpression(
      statement.expression,
      returnBucket
    );
  }
  if (ts.isIfStatement(statement)) {
    if (!isPureBagCondition(statement.expression, bagState, checker)) {
      return false;
    }
    if (
      !collectStatementReturnExpressions(
        statement.thenStatement,
        bagState,
        checker,
        returnBucket
      )
    ) {
      return false;
    }
    if (statement.elseStatement) {
      return collectStatementReturnExpressions(
        statement.elseStatement,
        bagState,
        checker,
        returnBucket
      );
    }
    return true;
  }
  if (ts.isVariableStatement(statement)) {
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
      return false;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        return false;
      }
      if (ts.isObjectBindingPattern(declaration.name)) {
        if (!isBagObjectReference(declaration.initializer, bagState, checker)) {
          return false;
        }
        if (
          !collectBindingPatternSymbols(
            declaration.name,
            checker,
            bagState.bagFieldSymbols
          )
        ) {
          return false;
        }
        continue;
      }
      if (ts.isIdentifier(declaration.name)) {
        const valueCheck = inspectBagValueExpression(
          declaration.initializer,
          bagState,
          checker
        );
        if (!valueCheck.valid || !valueCheck.readsBagField) {
          return false;
        }
        const localSymbol = resolveAliasedSymbol(
          checker,
          checker.getSymbolAtLocation(declaration.name)
        );
        if (!localSymbol) {
          return false;
        }
        bagState.bagFieldSymbols.add(localSymbol);
        continue;
      }
      return false;
    }
    return true;
  }
  return false;
}

function namedContractFromTypeNode(typeNode, sourceFile) {
  if (!typeNode) {
    return null;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return namedContractFromTypeNode(typeNode.type, sourceFile);
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return null;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sourceFile);
    if (typeName === "Record") {
      return null;
    }
    if (
      ANONYMOUS_UTILITY_TYPE_NAMES.has(typeName) &&
      typeNode.typeArguments?.length === 1 &&
      ts.isTypeLiteralNode(typeNode.typeArguments[0])
    ) {
      return null;
    }
    return typeNode.getText(sourceFile);
  }
  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return typeNode.getText(sourceFile);
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const part of typeNode.types) {
      if (
        part.kind === ts.SyntaxKind.UndefinedKeyword ||
        part.kind === ts.SyntaxKind.NullKeyword ||
        part.kind === ts.SyntaxKind.VoidKeyword ||
        (ts.isLiteralTypeNode(part) &&
          part.literal.kind === ts.SyntaxKind.NullKeyword)
      ) {
        continue;
      }
      const contractName = namedContractFromTypeNode(part, sourceFile);
      if (contractName) {
        return contractName;
      }
    }
  }
  return null;
}

function explicitTypeNodeOnExpression(expression) {
  let current = expression;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) &&
      current.type
    ) {
      return current.type;
    }
    break;
  }
  return null;
}

function containerReturnTypeNode(containerNode) {
  if (
    containerNode &&
    (ts.isVariableDeclaration(containerNode) ||
      ts.isPropertyDeclaration(containerNode)) &&
    containerNode.type &&
    ts.isFunctionTypeNode(containerNode.type)
  ) {
    return containerNode.type.type;
  }
  return null;
}

function classifyBagReshaper(functionNode, containerNode, checker, sourceFile) {
  if (
    !functionNode?.body ||
    functionNode.asteriskToken ||
    functionNode.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
    )
  ) {
    return null;
  }
  const bagParameter = resolveBagParameter(functionNode, checker, sourceFile);
  if (!bagParameter) {
    return null;
  }
  const bagState = {
    bagRootSymbols: new Set(bagParameter.bagRootSymbols),
    bagFieldSymbols: new Set(bagParameter.bagFieldSymbols),
  };
  const returnExpressions = [];
  if (ts.isBlock(functionNode.body)) {
    if (
      !collectStatementReturnExpressions(
        functionNode.body,
        bagState,
        checker,
        returnExpressions
      )
    ) {
      return null;
    }
  } else if (
    !collectReturnExpressionsFromExpression(
      functionNode.body,
      returnExpressions
    )
  ) {
    return null;
  }
  if (returnExpressions.length === 0) {
    return null;
  }
  const declaredReturnTypeNode =
    functionNode.type ?? containerReturnTypeNode(containerNode);
  let targetContract = namedContractFromTypeNode(
    declaredReturnTypeNode,
    sourceFile
  );
  for (const returnExpression of returnExpressions) {
    const assertionTypeNode = explicitTypeNodeOnExpression(returnExpression);
    if (!targetContract && assertionTypeNode) {
      targetContract = namedContractFromTypeNode(assertionTypeNode, sourceFile);
    }
    const unwrappedReturn = unwrapExpression(returnExpression);
    if (
      !unwrappedReturn ||
      !ts.isObjectLiteralExpression(unwrappedReturn) ||
      !inspectObjectLiteralBagProjection(unwrappedReturn, bagState, checker)
    ) {
      return null;
    }
  }
  if (targetContract) {
    return {
      messageId: "bagToContract",
      data: {
        parameterName: bagParameter.parameterName,
        targetContract,
      },
    };
  }
  return {
    messageId: "bagToBag",
    data: {
      parameterName: bagParameter.parameterName,
    },
  };
}

function callableInitializer(initializer) {
  const unwrapped = unwrapExpression(initializer);
  if (
    unwrapped &&
    (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped))
  ) {
    return unwrapped;
  }
  return null;
}

export function ruleNoBagReshaper() {
  return defineTypeScriptRule({
    ruleName: "no-bag-reshaper",
    skipNonRuleFile: true,
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow helper functions that reshape a parameter bag into a named target contract without validation ('bagToContract') or repack a parameter bag into another ad-hoc object bag ('bagToBag').",
      },
      schema: [
        {
          type: "object",
          properties: scopeProperties,
          additionalProperties: false,
        },
      ],
      messages: {
        bagToContract:
          "Do not reshape parameter bag '{{parameterName}}' into target contract '{{targetContract}}' without boundary validation or domain construction; pass '{{targetContract}}' from its owner or decode at the boundary.",
        bagToBag:
          "Do not repack parameter bag '{{parameterName}}' into another ad-hoc object bag; read the owner's fields directly at the call site instead of threading a reshaped bag.",
      },
    },
    run({ sourceFile, checker, filename, reportNode }) {
      if (isTestFilename(filename)) {
        return {};
      }
      function inspectCandidateNode(candidateNode) {
        const functionNode =
          ts.isFunctionDeclaration(candidateNode) ||
          ts.isMethodDeclaration(candidateNode)
            ? candidateNode
            : callableInitializer(candidateNode.initializer);
        if (!functionNode) {
          return;
        }
        const containerNode =
          functionNode === candidateNode ? null : candidateNode;
        const classification = classifyBagReshaper(
          functionNode,
          containerNode,
          checker,
          sourceFile
        );
        if (!classification) {
          return;
        }
        reportNode(candidateNode, classification);
      }
      return {
        [ts.SyntaxKind.FunctionDeclaration]: inspectCandidateNode,
        [ts.SyntaxKind.MethodDeclaration]: inspectCandidateNode,
        [ts.SyntaxKind.VariableDeclaration]: inspectCandidateNode,
        [ts.SyntaxKind.PropertyDeclaration]: inspectCandidateNode,
        [ts.SyntaxKind.PropertyAssignment]: inspectCandidateNode,
      };
    },
  });
}

export default ruleNoBagReshaper();
