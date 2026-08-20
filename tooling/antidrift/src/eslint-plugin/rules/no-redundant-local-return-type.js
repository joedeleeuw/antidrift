import ts from "typescript";

import { isBoundary } from "../../semantic-adapters/local-ast-rules.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

const unsafeTypeFlags =
  ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;

function functionCandidate(node) {
  if (node.type === "FunctionDeclaration") {
    return node.body ? { fn: node, owner: node, name: node.id } : null;
  }
  if (
    node.type !== "VariableDeclarator" ||
    node.id?.type !== "Identifier" ||
    node.id.typeAnnotation ||
    node.parent?.kind !== "const"
  ) {
    return null;
  }
  if (
    node.init?.type !== "ArrowFunctionExpression" &&
    node.init?.type !== "FunctionExpression"
  ) {
    return null;
  }
  return { fn: node.init, owner: node, name: node.id };
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function singleReturnedObject(fn) {
  if (fn.body?.type === "ObjectExpression") return fn.body;
  if (fn.body?.type !== "BlockStatement") return null;
  const finalStatement = fn.body.body.at(-1);
  if (
    finalStatement?.type !== "ReturnStatement" ||
    finalStatement.argument?.type !== "ObjectExpression"
  ) {
    return null;
  }
  let returns = 0;
  function visit(node) {
    if (
      node !== fn.body &&
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression")
    ) {
      return;
    }
    if (node.type === "ReturnStatement") returns += 1;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") visit(child);
        }
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  }
  visit(fn.body);
  return returns === 1 ? finalStatement.argument : null;
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
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : null;
    if (!name || properties.has(name)) return null;
    properties.set(name, member);
  }
  return properties.size > 0 ? properties : null;
}

function shorthandProperties(objectExpression) {
  const properties = new Map();
  for (const property of objectExpression.properties) {
    if (
      property.type !== "Property" ||
      !property.shorthand ||
      property.computed ||
      property.kind !== "init" ||
      property.key?.type !== "Identifier" ||
      property.value?.type !== "Identifier" ||
      properties.has(property.key.name)
    ) {
      return null;
    }
    properties.set(property.key.name, property.value);
  }
  return properties.size > 0 ? properties : null;
}

function symbolForNode(checker, services, node) {
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return tsNode ? checker.getSymbolAtLocation(tsNode) : null;
}

function referencesSymbol(checker, root, symbol) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function hasOverload(symbol) {
  return (symbol?.declarations?.length ?? 0) > 1;
}

function functionOwner(fn) {
  if (
    (fn?.type === "FunctionExpression" ||
      fn?.type === "ArrowFunctionExpression") &&
    fn.parent?.type === "VariableDeclarator"
  ) {
    return fn.parent;
  }
  if (fn?.parent?.type === "Property") return fn.parent;
  return fn;
}

function canonicalSymbol(checker, symbol) {
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function symbolAtIdentifier(checker, node) {
  if (
    ts.isShorthandPropertyAssignment(node.parent) &&
    node.parent.name === node
  ) {
    return canonicalSymbol(
      checker,
      checker.getShorthandAssignmentValueSymbol(node.parent),
    );
  }
  return canonicalSymbol(checker, checker.getSymbolAtLocation(node));
}

function declarationDependsOnSymbol(
  checker,
  declaration,
  target,
  sourceFile,
  seen,
) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node)) {
      const symbol = symbolAtIdentifier(checker, node);
      if (symbol === target) {
        if (
          !ts.isCallExpression(node.parent) ||
          node.parent.expression !== node
        ) {
          found = true;
        }
        return;
      }
      if (symbol && !seen.has(symbol)) {
        const localDeclarations = (symbol.declarations ?? []).filter(
          (candidate) => candidate.getSourceFile() === sourceFile,
        );
        if (localDeclarations.length > 0) {
          seen.add(symbol);
          found = localDeclarations.some((candidate) =>
            declarationDependsOnSymbol(
              checker,
              candidate,
              target,
              sourceFile,
              seen,
            ),
          );
          if (found) return;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration);
  return found;
}

function isPubliclyExposed(checker, declaration, symbol) {
  const sourceFile = declaration?.getSourceFile();
  const moduleSymbol = sourceFile
    ? checker.getSymbolAtLocation(sourceFile)
    : null;
  if (!sourceFile || !symbol) return true;
  if (!moduleSymbol) return false;
  const target = canonicalSymbol(checker, symbol);
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    const exported =
      ts.isExportAssignment(statement) ||
      ts.isExportDeclaration(statement) ||
      modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
    if (
      exported &&
      declarationDependsOnSymbol(
        checker,
        statement,
        target,
        sourceFile,
        new Set(),
      )
    ) {
      return true;
    }
  }
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const exportedTarget = canonicalSymbol(checker, exported);
    if (exportedTarget === target) return true;
    const declarations = new Set([
      ...(exported.declarations ?? []),
      ...(exportedTarget?.declarations ?? []),
    ]);
    const seen = new Set([exported, exportedTarget].filter(Boolean));
    if (
      [...declarations].some((candidate) =>
        declarationDependsOnSymbol(
          checker,
          candidate,
          target,
          sourceFile,
          seen,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

function escapesThroughBoundary(checker, services, candidate) {
  const outer = enclosingFunction(candidate.owner);
  const outerOwner = functionOwner(outer);
  const tsOuterOwner = services.esTreeNodeToTSNodeMap.get(outerOwner);
  const outerSymbol = symbolForNode(
    checker,
    services,
    outerOwner.id ?? outerOwner.key,
  );
  if (
    !outer ||
    !outerOwner ||
    (!isBoundary(outerOwner) &&
      !isPubliclyExposed(checker, tsOuterOwner, outerSymbol))
  ) {
    return false;
  }
  const tsOuter = services.esTreeNodeToTSNodeMap.get(outer);
  const symbol = symbolForNode(checker, services, candidate.name);
  if (!tsOuter?.body || !symbol) return true;
  let escaped = false;
  function visit(node) {
    if (escaped) return;
    if (node !== tsOuter.body && ts.isFunctionLike(node)) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      referencesSymbol(checker, node.expression, symbol)
    ) {
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tsOuter.body);
  return escaped;
}

function referencesLocalFunction(checker, root, ownSymbol) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
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
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function hasTypedOwnerProof(
  checker,
  services,
  candidate,
  symbol,
  declaredType,
) {
  const outer = enclosingFunction(candidate.owner);
  const tsOuter = services.esTreeNodeToTSNodeMap.get(outer);
  const tsOwner = services.esTreeNodeToTSNodeMap.get(candidate.owner);
  if (!outer?.returnType || !tsOuter?.body || !tsOwner) return false;
  let calls = 0;
  let valid = true;
  function visit(node) {
    if (!valid || node === tsOwner) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      if (
        !ts.isCallExpression(node.parent) ||
        node.parent.expression !== node
      ) {
        valid = false;
        return;
      }
      const call = node.parent;
      let current = call.parent;
      while (current && current !== tsOuter.body) {
        if (ts.isFunctionLike(current)) {
          valid = false;
          return;
        }
        if (ts.isReturnStatement(current)) break;
        current = current.parent;
      }
      if (
        !current ||
        current === tsOuter.body ||
        !ts.isReturnStatement(current) ||
        checker.getContextualType(call) !== declaredType
      ) {
        valid = false;
        return;
      }
      calls += 1;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tsOuter.body);
  return valid && calls > 0;
}

function exactPropertyTypes({
  checker,
  declaredType,
  objectProperties,
  typeProperties,
  services,
}) {
  if (
    objectProperties.size !== typeProperties.size ||
    declaredType.getCallSignatures().length > 0 ||
    declaredType.getConstructSignatures().length > 0 ||
    checker.getIndexInfosOfType(declaredType).length > 0
  ) {
    return false;
  }
  for (const [name, expression] of objectProperties) {
    const typeProperty = typeProperties.get(name);
    const declaredProperty = checker.getPropertyOfType(declaredType, name);
    const tsExpression = services.esTreeNodeToTSNodeMap.get(expression);
    if (!typeProperty || !declaredProperty || !tsExpression) return false;
    const expressionType = checker.getTypeAtLocation(tsExpression);
    const propertyType = checker.getTypeOfSymbolAtLocation(
      declaredProperty,
      typeProperty,
    );
    if (
      expressionType !== propertyType ||
      expressionType.flags & unsafeTypeFlags ||
      expressionType.getCallSignatures().length > 0
    ) {
      return false;
    }
  }
  return true;
}

export function ruleNoRedundantLocalReturnType() {
  return {
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
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-redundant-local-return-type",
        );
      }
      const checker = services.program.getTypeChecker();

      function check(node) {
        const candidate = functionCandidate(node);
        if (
          !candidate ||
          !candidate.fn.returnType ||
          candidate.fn.async ||
          candidate.fn.generator ||
          !enclosingFunction(candidate.owner) ||
          isBoundary(candidate.owner) ||
          escapesThroughBoundary(checker, services, candidate)
        ) {
          return;
        }
        const returnedObject = singleReturnedObject(candidate.fn);
        const objectProperties = returnedObject
          ? shorthandProperties(returnedObject)
          : null;
        if (!objectProperties) return;
        const tsReturnType = services.esTreeNodeToTSNodeMap.get(
          candidate.fn.returnType.typeAnnotation,
        );
        const tsBody = services.esTreeNodeToTSNodeMap.get(candidate.fn.body);
        const symbol = symbolForNode(checker, services, candidate.name);
        if (
          !tsReturnType ||
          !tsBody ||
          !symbol ||
          hasOverload(symbol) ||
          referencesSymbol(checker, tsBody, symbol) ||
          referencesLocalFunction(checker, tsBody, symbol)
        ) {
          return;
        }
        const typeProperties = directMutableTypeLiteral(checker, tsReturnType);
        if (!typeProperties) return;
        const declaredType = checker.getTypeFromTypeNode(tsReturnType);
        if (
          !hasTypedOwnerProof(
            checker,
            services,
            candidate,
            symbol,
            declaredType,
          ) ||
          !exactPropertyTypes({
            checker,
            declaredType,
            objectProperties,
            typeProperties,
            services,
          })
        ) {
          return;
        }
        context.report({
          node: candidate.fn.returnType,
          messageId: "redundantLocalReturnType",
        });
      }

      return {
        FunctionDeclaration: check,
        VariableDeclarator: check,
      };
    },
  };
}
