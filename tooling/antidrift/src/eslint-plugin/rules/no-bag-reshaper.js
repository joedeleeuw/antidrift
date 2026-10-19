import ts from "typescript";

import { scopeProperties } from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTestFilename } from "../../oxlint-plugin/portable/syntax.js";
import {
  collectReturnExpressionsFromExpression,
  collectStatementReturnExpressions,
  inspectObjectLiteralBagProjection,
  resolveBagParameter,
} from "../../semantic-adapters/projection/bag-projection.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";
import { unwrapTransparent } from "../../semantic-adapters/kernel/transparent-expression.ts";

const ANONYMOUS_UTILITY_TYPE_NAMES = new Set([
  "Omit",
  "Partial",
  "Pick",
  "Readonly",
  "Record",
  "Required",
]);

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

function propertyNameText(name) {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteralLike(name.expression) ||
      ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return null;
}

function satisfiesTableTypeNodeForRow(containerNode) {
  if (!containerNode || !ts.isPropertyAssignment(containerNode)) {
    return null;
  }
  const tableLiteral = containerNode.parent;
  if (!ts.isObjectLiteralExpression(tableLiteral)) {
    return null;
  }
  const tableExpression = tableLiteral.parent;
  if (
    !tableExpression ||
    !ts.isSatisfiesExpression(tableExpression) ||
    tableExpression.expression !== tableLiteral
  ) {
    return null;
  }
  return tableExpression.type;
}

function rowContractReturnType(checker, containerNode, tableTypeNode) {
  const rowKey = propertyNameText(containerNode.name);
  if (rowKey === null) {
    return null;
  }
  const tableType = checker.getTypeFromTypeNode(tableTypeNode);
  const rowSymbol = checker.getPropertyOfType(tableType, rowKey);
  if (!rowSymbol) {
    return null;
  }
  const rowType = checker.getTypeOfSymbolAtLocation(rowSymbol, containerNode);
  const [signature] = rowType.getCallSignatures();
  return signature ? checker.getReturnTypeOfSignature(signature) : null;
}

function constructsDeclaredUnionMember(
  checker,
  contractReturnType,
  objectLiteral
) {
  const members = contractReturnType.types.filter(
    (member) => (member.flags & ts.TypeFlags.Object) !== 0
  );
  if (members.length < 2) {
    return false;
  }
  if (
    !checker.isTypeAssignableTo(
      checker.getTypeAtLocation(objectLiteral),
      contractReturnType
    )
  ) {
    return false;
  }
  return objectLiteral.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const discriminantName = propertyNameText(property.name);
    if (discriminantName === null) {
      return false;
    }
    const discriminantInitializer = unwrapTransparent(property.initializer);
    if (
      !ts.isStringLiteralLike(discriminantInitializer) &&
      !ts.isNumericLiteral(discriminantInitializer)
    ) {
      return false;
    }
    return members.some((member) => {
      const memberProperty = checker.getPropertyOfType(
        member,
        discriminantName
      );
      if (!memberProperty) {
        return false;
      }
      const memberPropertyType = checker.getTypeOfSymbolAtLocation(
        memberProperty,
        property.initializer
      );
      return (
        memberPropertyType.isLiteral() &&
        checker.isTypeAssignableTo(
          checker.getTypeAtLocation(property.initializer),
          memberPropertyType
        )
      );
    });
  });
}

function satisfiesRowIsDomainConstruction(
  checker,
  containerNode,
  returnExpressions
) {
  const tableTypeNode = satisfiesTableTypeNodeForRow(containerNode);
  if (!tableTypeNode) {
    return false;
  }
  const contractReturnType = rowContractReturnType(
    checker,
    containerNode,
    tableTypeNode
  );
  if (!contractReturnType || !contractReturnType.isUnion()) {
    return false;
  }
  return returnExpressions.every((returnExpression) => {
    const unwrappedReturn = unwrapTransparent(returnExpression);
    return (
      ts.isObjectLiteralExpression(unwrappedReturn) &&
      constructsDeclaredUnionMember(
        checker,
        contractReturnType,
        unwrappedReturn
      )
    );
  });
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
  const { scope } = bagParameter;
  const returnExpressions = [];
  if (ts.isBlock(functionNode.body)) {
    if (
      !collectStatementReturnExpressions(
        scope,
        functionNode.body,
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
  if (
    satisfiesRowIsDomainConstruction(checker, containerNode, returnExpressions)
  ) {
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
    const unwrappedReturn = unwrapTransparent(returnExpression);
    if (
      !ts.isObjectLiteralExpression(unwrappedReturn) ||
      !inspectObjectLiteralBagProjection(scope, unwrappedReturn, {
        wholeRootReferenceIsEnvelope: true,
      })
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
  const unwrapped = initializer && unwrapTransparent(initializer);
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
