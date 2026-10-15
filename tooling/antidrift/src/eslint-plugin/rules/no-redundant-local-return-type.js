import ts from "typescript";

import { shapeComparison } from "../../semantic-adapters/shape-identity.mjs";
import {
  defineTypeScriptRule,
  isSymbolPubliclyExported,
  symbolAtNode,
} from "../../semantic-adapters/ts-rule-kernel.mjs";

const unsafeTypeFlags =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;

function functionCandidate(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.body && node.name
      ? { functionNode: node, ownerNode: node, nameNode: node.name }
      : null;
  }
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    node.type ||
    !ts.isVariableDeclarationList(node.parent) ||
    !(node.parent.flags & ts.NodeFlags.Const) ||
    !node.initializer ||
    (!ts.isArrowFunction(node.initializer) &&
      !ts.isFunctionExpression(node.initializer))
  ) {
    return null;
  }
  return {
    functionNode: node.initializer,
    ownerNode: node,
    nameNode: node.name,
  };
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function functionOwner(functionNode) {
  if (
    (ts.isFunctionExpression(functionNode) ||
      ts.isArrowFunction(functionNode)) &&
    ts.isVariableDeclaration(functionNode.parent)
  ) {
    return functionNode.parent;
  }
  if (functionNode.parent && ts.isPropertyAssignment(functionNode.parent)) {
    return functionNode.parent;
  }
  return functionNode;
}

function isExportedStatement(statement) {
  const modifiers = ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement)
    : undefined;
  return Boolean(
    modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword
    )
  );
}

function isExportedOwner(ownerNode) {
  if (ts.isVariableDeclaration(ownerNode)) {
    const statement = ownerNode.parent?.parent;
    return Boolean(
      statement &&
      ts.isVariableStatement(statement) &&
      isExportedStatement(statement)
    );
  }
  return isExportedStatement(ownerNode);
}

function singleReturnedObject(functionNode) {
  const body = functionNode.body;
  if (!body) {
    return null;
  }
  if (
    ts.isParenthesizedExpression(body) &&
    ts.isObjectLiteralExpression(body.expression)
  ) {
    return body.expression;
  }
  if (!ts.isBlock(body)) {
    return null;
  }
  const finalStatement = body.statements.at(-1);
  if (
    !finalStatement ||
    !ts.isReturnStatement(finalStatement) ||
    !finalStatement.expression ||
    !ts.isObjectLiteralExpression(finalStatement.expression)
  ) {
    return null;
  }
  let returnCount = 0;
  function visit(currentNode) {
    if (
      currentNode !== body &&
      (ts.isFunctionDeclaration(currentNode) ||
        ts.isFunctionExpression(currentNode) ||
        ts.isArrowFunction(currentNode))
    ) {
      return;
    }
    if (ts.isReturnStatement(currentNode)) {
      returnCount += 1;
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(body);
  return returnCount === 1 ? finalStatement.expression : null;
}

function shorthandProperties(objectLiteral) {
  const properties = new Map();
  for (const property of objectLiteral.properties) {
    if (
      !ts.isShorthandPropertyAssignment(property) ||
      properties.has(property.name.text)
    ) {
      return null;
    }
    properties.set(property.name.text, property.name);
  }
  return properties.size > 0 ? properties : null;
}

function directMutableTypeLiteral(checker, typeNode) {
  if (
    !ts.isTypeReferenceNode(typeNode) ||
    !ts.isIdentifier(typeNode.typeName)
  ) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  const declaration =
    symbol?.declarations?.length === 1 ? symbol.declarations[0] : null;
  if (
    !declaration ||
    !ts.isTypeAliasDeclaration(declaration) ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    !ts.isTypeLiteralNode(declaration.type)
  ) {
    return null;
  }
  const properties = new Map();
  for (const member of declaration.type.members) {
    if (
      !ts.isPropertySignature(member) ||
      !member.type ||
      member.questionToken ||
      ts
        .getModifiers(member)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
    ) {
      return null;
    }
    const memberName =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : null;
    if (!memberName || properties.has(memberName)) {
      return null;
    }
    properties.set(memberName, member);
  }
  return properties.size > 0 ? properties : null;
}

function referencesSymbol(checker, rootNode, targetSymbol) {
  let found = false;
  function visit(currentNode) {
    if (found) {
      return;
    }
    if (
      ts.isIdentifier(currentNode) &&
      symbolAtNode(checker, currentNode) === targetSymbol
    ) {
      found = true;
      return;
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(rootNode);
  return found;
}

function referencesLocalFunction(checker, rootNode, ownSymbol) {
  let found = false;
  function visit(currentNode) {
    if (found) {
      return;
    }
    if (ts.isIdentifier(currentNode)) {
      const symbol = checker.getSymbolAtLocation(currentNode);
      if (symbol && symbol !== ownSymbol) {
        for (const declaration of symbol.declarations ?? []) {
          if (
            ts.isFunctionDeclaration(declaration) ||
            (ts.isVariableDeclaration(declaration) &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer)))
          ) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(rootNode);
  return found;
}

function escapesThroughBoundary(checker, candidate, candidateSymbol) {
  const outer = enclosingFunction(candidate.ownerNode);
  if (!outer) {
    return false;
  }
  const outerOwner = functionOwner(outer);
  const outerNameNode = outerOwner.name ?? null;
  const outerSymbol = outerNameNode
    ? checker.getSymbolAtLocation(outerNameNode)
    : null;
  if (
    !isExportedOwner(outerOwner) &&
    !isSymbolPubliclyExported(checker, outerOwner, outerSymbol)
  ) {
    return false;
  }
  if (!outer.body || !candidateSymbol) {
    return true;
  }
  let escaped = false;
  function visit(currentNode) {
    if (escaped) {
      return;
    }
    if (currentNode !== outer.body && ts.isFunctionLike(currentNode)) {
      return;
    }
    if (
      ts.isReturnStatement(currentNode) &&
      currentNode.expression &&
      referencesSymbol(checker, currentNode.expression, candidateSymbol)
    ) {
      escaped = true;
      return;
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(outer.body);
  return escaped;
}

function hasTypedOwnerProof(checker, candidate, candidateSymbol, declaredType) {
  const outer = enclosingFunction(candidate.ownerNode);
  if (!outer?.type || !outer.body) {
    return false;
  }
  let calls = 0;
  let valid = true;
  function visit(currentNode) {
    if (!valid || currentNode === candidate.ownerNode) {
      return;
    }
    if (
      ts.isIdentifier(currentNode) &&
      checker.getSymbolAtLocation(currentNode) === candidateSymbol
    ) {
      if (
        !ts.isCallExpression(currentNode.parent) ||
        currentNode.parent.expression !== currentNode
      ) {
        valid = false;
        return;
      }
      const call = currentNode.parent;
      let ancestor = call.parent;
      while (ancestor && ancestor !== outer.body) {
        if (ts.isFunctionLike(ancestor)) {
          valid = false;
          return;
        }
        if (ts.isReturnStatement(ancestor)) {
          break;
        }
        ancestor = ancestor.parent;
      }
      if (
        !ancestor ||
        ancestor === outer.body ||
        !ts.isReturnStatement(ancestor) ||
        checker.getContextualType(call) !== declaredType
      ) {
        valid = false;
        return;
      }
      calls += 1;
      return;
    }
    ts.forEachChild(currentNode, visit);
  }
  visit(outer.body);
  return valid && calls > 0;
}

function exactPropertyTypes({
  checker,
  sameShape,
  declaredType,
  objectProperties,
  typeProperties,
}) {
  if (
    objectProperties.size !== typeProperties.size ||
    declaredType.getCallSignatures().length > 0 ||
    declaredType.getConstructSignatures().length > 0 ||
    checker.getIndexInfosOfType(declaredType).length > 0
  ) {
    return false;
  }
  for (const [propertyName, identifierNode] of objectProperties) {
    const typeProperty = typeProperties.get(propertyName);
    const declaredProperty = checker.getPropertyOfType(
      declaredType,
      propertyName
    );
    if (!typeProperty || !declaredProperty) {
      return false;
    }
    const expressionType = checker.getTypeAtLocation(identifierNode);
    const propertyType = checker.getTypeOfSymbolAtLocation(
      declaredProperty,
      typeProperty
    );
    if (
      expressionType.flags & unsafeTypeFlags ||
      expressionType.getCallSignatures().length > 0 ||
      (expressionType !== propertyType &&
        sameShape(expressionType, propertyType) !== true)
    ) {
      return false;
    }
  }
  return true;
}

export function ruleNoRedundantLocalReturnType() {
  return defineTypeScriptRule({
    ruleName: "no-redundant-local-return-type",
    skipGenerated: false,
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow a redundant named object return type on a nested local implementation when an enclosing typed owner preserves the contract.",
      },
      schema: [],
      messages: {
        redundantLocalReturnType:
          "This nested implementation's explicit return type repeats its inferred shorthand-object shape, and every call is constrained by the enclosing function's return contract. Remove the local annotation and keep the named type at that owner.",
      },
    },
    run({ checker, program, reportNode }) {
      const sameShape = shapeComparison(program);
      function checkDeclaration(declarationNode) {
        const candidate = functionCandidate(declarationNode);
        if (
          !candidate ||
          !candidate.functionNode.type ||
          Boolean(
            ts.getCombinedModifierFlags(candidate.functionNode) &
            ts.ModifierFlags.Async
          ) ||
          Boolean(candidate.functionNode.asteriskToken) ||
          !enclosingFunction(candidate.ownerNode) ||
          isExportedOwner(candidate.ownerNode)
        ) {
          return;
        }
        const symbol = checker.getSymbolAtLocation(candidate.nameNode);
        if (
          !symbol ||
          (symbol.declarations?.length ?? 0) > 1 ||
          escapesThroughBoundary(checker, candidate, symbol)
        ) {
          return;
        }
        const returnedObject = singleReturnedObject(candidate.functionNode);
        const objectProperties = returnedObject
          ? shorthandProperties(returnedObject)
          : null;
        if (!objectProperties) {
          return;
        }
        const returnTypeNode = candidate.functionNode.type;
        const bodyNode = candidate.functionNode.body;
        if (
          referencesSymbol(checker, bodyNode, symbol) ||
          referencesLocalFunction(checker, bodyNode, symbol)
        ) {
          return;
        }
        const typeProperties = directMutableTypeLiteral(
          checker,
          returnTypeNode
        );
        if (!typeProperties) {
          return;
        }
        const declaredType = checker.getTypeFromTypeNode(returnTypeNode);
        if (
          !hasTypedOwnerProof(checker, candidate, symbol, declaredType) ||
          !exactPropertyTypes({
            checker,
            sameShape,
            declaredType,
            objectProperties,
            typeProperties,
          })
        ) {
          return;
        }
        reportNode(returnTypeNode, {
          messageId: "redundantLocalReturnType",
        });
      }
      return {
        [ts.SyntaxKind.FunctionDeclaration]: checkDeclaration,
        [ts.SyntaxKind.VariableDeclaration]: checkDeclaration,
      };
    },
  });
}
