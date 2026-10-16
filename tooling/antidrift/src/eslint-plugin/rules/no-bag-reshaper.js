import ts from "typescript";

import { scopeProperties } from "../../oxlint-plugin/portable/scope.js";
import { isTestFilename } from "../../oxlint-plugin/portable/syntax.js";
import {
  collectReturnExpressionsFromExpression,
  collectStatementReturnExpressions,
  inspectObjectLiteralBagProjection,
  resolveBagParameter,
  unwrapExpression,
} from "../../semantic-adapters/bag-projection.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/ts-rule-kernel.mjs";

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
