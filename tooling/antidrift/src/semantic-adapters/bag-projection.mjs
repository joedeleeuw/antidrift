import ts from "typescript";

import {
  resolveAliasedSymbol,
  symbolAtNode,
} from "./provenance/symbol-provenance.ts";

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

export function unwrapExpression(expression) {
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

export function isNullishExpression(expression) {
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

export function isStaticScalarLiteral(expression) {
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

export function isEmptyObjectFallback(expression) {
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

export function collectBindingPatternSymbols(
  bindingPattern,
  checker,
  symbolBucket
) {
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

export function resolveBagParameter(functionNode, checker, sourceFile) {
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

export function isBagMemberChain(expression, bagState, checker) {
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

export function isBagObjectReference(expression, bagState, checker) {
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

export function isPureBagCondition(expression, bagState, checker) {
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

export function inspectBagValueExpression(expression, bagState, checker) {
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

export function inspectObjectLiteralBagProjection(
  objectLiteral,
  bagState,
  checker
) {
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

export function collectReturnExpressionsFromExpression(
  expression,
  returnBucket
) {
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

export function collectStatementReturnExpressions(
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

function findSingleRootSource(expression, checker) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) {
    return null;
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) ||
    (ts.isElementAccessExpression(unwrapped) &&
      isStaticScalarLiteral(unwrapped.argumentExpression))
  ) {
    let base = unwrapExpression(unwrapped.expression);
    while (
      base &&
      (ts.isPropertyAccessExpression(base) ||
        (ts.isElementAccessExpression(base) &&
          isStaticScalarLiteral(base.argumentExpression)))
    ) {
      base = unwrapExpression(base.expression);
    }
    if (base && ts.isIdentifier(base)) {
      const symbol = symbolAtNode(checker, base);
      return symbol ? { symbol, name: base.text } : null;
    }
    return null;
  }
  if (ts.isSpreadAssignment(unwrapped)) {
    const target = unwrapExpression(unwrapped.expression);
    if (target && ts.isIdentifier(target)) {
      const symbol = symbolAtNode(checker, target);
      return symbol ? { symbol, name: target.text } : null;
    }
    return findSingleRootSource(target, checker);
  }
  let discovered = null;
  ts.forEachChild(unwrapped, (child) => {
    if (!discovered) {
      discovered = findSingleRootSource(child, checker);
    }
  });
  return discovered;
}

function isInlineReshapeBranch(branch, bagState, checker) {
  const unwrapped = unwrapExpression(branch);
  if (!unwrapped) {
    return false;
  }
  if (isBagObjectReference(unwrapped, bagState, checker)) {
    return true;
  }
  if (
    !ts.isObjectLiteralExpression(unwrapped) ||
    unwrapped.properties.length === 0
  ) {
    return false;
  }
  return unwrapped.properties.every((property) => {
    if (ts.isSpreadAssignment(property)) {
      return isBagObjectReference(property.expression, bagState, checker);
    }
    if (ts.isPropertyAssignment(property)) {
      return inspectBagValueExpression(property.initializer, bagState, checker)
        .valid;
    }
    return false;
  });
}

function isInsideCombinatorCallback(node) {
  let current = node.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (
        parent &&
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        (parent.expression.name.text === "preprocess" ||
          parent.expression.name.text === "transform")
      ) {
        return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
}

export function classifyInlineParseReshape(tsArg, checker) {
  if (!tsArg || isInsideCombinatorCallback(tsArg)) {
    return null;
  }
  const rawArg = unwrapExpression(tsArg);
  if (!rawArg) {
    return null;
  }
  const rootSource = findSingleRootSource(rawArg, checker);
  if (!rootSource) {
    return null;
  }
  const bagState = {
    bagRootSymbols: new Set([rootSource.symbol]),
    bagFieldSymbols: new Set(),
  };
  if (
    ts.isObjectLiteralExpression(rawArg) &&
    inspectObjectLiteralBagProjection(rawArg, bagState, checker)
  ) {
    return {
      messageId: "inlineObjectReshape",
      data: { source: rootSource.name },
    };
  }
  if (
    ts.isConditionalExpression(rawArg) &&
    isPureBagCondition(rawArg.condition, bagState, checker) &&
    isInlineReshapeBranch(rawArg.whenTrue, bagState, checker) &&
    isInlineReshapeBranch(rawArg.whenFalse, bagState, checker) &&
    (ts.isObjectLiteralExpression(unwrapExpression(rawArg.whenTrue)) ||
      ts.isObjectLiteralExpression(unwrapExpression(rawArg.whenFalse)))
  ) {
    return {
      messageId: "inlineConditionalReshape",
      data: { source: rootSource.name },
    };
  }
  return null;
}
