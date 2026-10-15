import ts from "typescript";

import { isRuleFile } from "../oxlint-plugin/portable/scope.js";
import { isDeclaredGeneratedSource } from "./generated-source.mjs";
import { declaresGenerated, shapeComparison } from "./shape-identity.mjs";

const serviceContractsByProgram = new WeakMap();

export function requireTypeServices(eslintContext) {
  const services =
    eslintContext.sourceCode?.parserServices ?? eslintContext.parserServices;
  if (services?.program && services.esTreeNodeToTSNodeMap) {
    return services;
  }
  return null;
}

export function tsNodeLocation(sourceFile, tsNode) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    tsNode.getStart(sourceFile)
  );
  const end = sourceFile.getLineAndCharacterOfPosition(tsNode.getEnd());
  return {
    start: { line: start.line + 1, column: start.character },
    end: { line: end.line + 1, column: end.character },
  };
}

function walkTypeScriptAst(currentNode, listeners) {
  const enter = listeners[currentNode.kind];
  if (typeof enter === "function") {
    enter(currentNode);
  }
  ts.forEachChild(currentNode, (childNode) => {
    walkTypeScriptAst(childNode, listeners);
  });
  const leave = listeners.exit?.[currentNode.kind];
  if (typeof leave === "function") {
    leave(currentNode);
  }
}

export function defineTypeScriptRule({
  ruleName,
  meta,
  skipGenerated = true,
  skipNonRuleFile = false,
  documentVisitors,
  visitors,
  run,
}) {
  const missingServicesMessage = `antidrift/${ruleName} requires TypeScript parser services. Use @joedeleeuw/antidrift createConfig(...) or configure @typescript-eslint/parser with projectService/project.`;
  return {
    meta,
    create(eslintContext) {
      if (
        typeof documentVisitors === "function" &&
        eslintContext.sourceCode?.ast?.type === "Document"
      ) {
        return documentVisitors(eslintContext);
      }
      if (skipNonRuleFile && !isRuleFile(eslintContext)) {
        return {};
      }
      if (
        skipGenerated &&
        eslintContext.sourceCode?.text &&
        isDeclaredGeneratedSource(eslintContext.sourceCode.text)
      ) {
        return {};
      }
      const services = requireTypeServices(eslintContext);
      if (!services) {
        return {
          Program(programNode) {
            eslintContext.report({
              node: programNode,
              message: missingServicesMessage,
            });
          },
        };
      }
      const program = services.program;
      const checker = program.getTypeChecker();
      if (typeof visitors === "function") {
        return visitors({
          context: eslintContext,
          checker,
          program,
          services,
          options: eslintContext.options,
          cwd: eslintContext.cwd,
          filename: eslintContext.filename,
        });
      }
      return {
        Program(programNode) {
          const sourceFile =
            services.esTreeNodeToTSNodeMap.get(programNode) ??
            program.getSourceFile(eslintContext.filename);
          if (!sourceFile || (skipGenerated && declaresGenerated(sourceFile))) {
            return;
          }
          function reportNode(targetNode, descriptor) {
            const esNode = services.tsNodeToESTreeNodeMap?.get(targetNode);
            if (esNode) {
              eslintContext.report({ node: esNode, ...descriptor });
              return;
            }
            eslintContext.report({
              loc: tsNodeLocation(sourceFile, targetNode),
              ...descriptor,
            });
          }
          const listeners = run({
            sourceFile,
            checker,
            program,
            services,
            options: eslintContext.options,
            cwd: eslintContext.cwd,
            filename: eslintContext.filename,
            reportNode,
            context: eslintContext,
          });
          if (!listeners) {
            return;
          }
          walkTypeScriptAst(sourceFile, listeners);
        },
      };
    },
  };
}

export function resolveAliasedSymbol(checker, symbol) {
  if (!symbol) {
    return null;
  }
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  const aliased = checker.getAliasedSymbol(symbol);
  if (
    !aliased ||
    (aliased.escapedName === "unknown" &&
      (aliased.declarations?.length ?? 0) === 0)
  ) {
    return symbol;
  }
  return aliased;
}

export function symbolAtNode(checker, node) {
  if (!node) {
    return null;
  }
  if (
    node.parent &&
    ts.isShorthandPropertyAssignment(node.parent) &&
    node.parent.name === node
  ) {
    return resolveAliasedSymbol(
      checker,
      checker.getShorthandAssignmentValueSymbol(node.parent)
    );
  }
  return resolveAliasedSymbol(checker, checker.getSymbolAtLocation(node));
}

function declarationDependsOnSymbol(
  checker,
  currentNode,
  targetSymbol,
  sourceFile,
  seen
) {
  if (ts.isIdentifier(currentNode)) {
    const symbol = symbolAtNode(checker, currentNode);
    if (symbol === targetSymbol) {
      return (
        !ts.isCallExpression(currentNode.parent) ||
        currentNode.parent.expression !== currentNode
      );
    }
    if (symbol && !seen.has(symbol)) {
      const localDeclarations = (symbol.declarations ?? []).filter(
        (candidate) => candidate.getSourceFile() === sourceFile
      );
      if (localDeclarations.length > 0) {
        seen.add(symbol);
        if (
          localDeclarations.some((candidate) =>
            declarationDependsOnSymbol(
              checker,
              candidate,
              targetSymbol,
              sourceFile,
              seen
            )
          )
        ) {
          return true;
        }
      }
    }
  }
  return Boolean(
    ts.forEachChild(currentNode, (childNode) =>
      declarationDependsOnSymbol(
        checker,
        childNode,
        targetSymbol,
        sourceFile,
        seen
      )
    )
  );
}

export function isSymbolPubliclyExported(checker, declaration, symbol) {
  const sourceFile = declaration?.getSourceFile();
  const moduleSymbol = sourceFile
    ? checker.getSymbolAtLocation(sourceFile)
    : null;
  if (!sourceFile || !symbol) {
    return true;
  }
  if (!moduleSymbol) {
    return false;
  }
  const targetSymbol = resolveAliasedSymbol(checker, symbol);
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
          modifier.kind === ts.SyntaxKind.DefaultKeyword
      );
    if (
      exported &&
      declarationDependsOnSymbol(
        checker,
        statement,
        targetSymbol,
        sourceFile,
        new Set()
      )
    ) {
      return true;
    }
  }
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const exportedTarget = resolveAliasedSymbol(checker, exported);
    if (exportedTarget === targetSymbol) {
      return true;
    }
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
          targetSymbol,
          sourceFile,
          seen
        )
      )
    ) {
      return true;
    }
  }
  return false;
}

export function resolveImportedModuleSourceFile(checker, importDeclaration) {
  if (
    !importDeclaration?.moduleSpecifier ||
    !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)
  ) {
    return null;
  }
  const moduleSymbol = checker.getSymbolAtLocation(
    importDeclaration.moduleSpecifier
  );
  const candidate =
    moduleSymbol?.valueDeclaration ?? moduleSymbol?.declarations?.[0] ?? null;
  return candidate && ts.isSourceFile(candidate) ? candidate : null;
}

const SERVICE_TAG_FACTORIES = new Set(["Tag", "GenericTag", "Service"]);

const SERVICE_TAG_NAMESPACES = new Set(["Context", "Effect"]);

const LAYER_FACTORY_METHODS = new Set([
  "effect",
  "scoped",
  "succeed",
  "sync",
  "unwrapEffect",
  "unwrapScoped",
  "function",
  "effectContext",
  "scopedContext",
]);

function calleeNamespaceAndMethod(expression) {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    return {
      namespaceName: expression.expression.text,
      methodName: expression.name.text,
    };
  }
  if (ts.isIdentifier(expression)) {
    return {
      namespaceName: null,
      methodName: expression.text,
    };
  }
  return null;
}

function isServiceTagCall(callExpression) {
  const direct = calleeNamespaceAndMethod(callExpression.expression);
  if (
    direct &&
    SERVICE_TAG_FACTORIES.has(direct.methodName) &&
    (!direct.namespaceName || SERVICE_TAG_NAMESPACES.has(direct.namespaceName))
  ) {
    return true;
  }
  if (ts.isCallExpression(callExpression.expression)) {
    return isServiceTagCall(callExpression.expression);
  }
  return false;
}

export function isLayerConstructionCall(callExpression) {
  const direct = calleeNamespaceAndMethod(callExpression.expression);
  if (!direct) {
    return false;
  }
  return (
    direct.namespaceName === "Layer" &&
    LAYER_FACTORY_METHODS.has(direct.methodName)
  );
}

function extractServiceShapeTypeFromTagCall(checker, callExpression) {
  const typeArguments = callExpression.typeArguments;
  if (typeArguments && typeArguments.length > 0) {
    const shapeNode =
      typeArguments.length >= 2 ? typeArguments[1] : typeArguments[0];
    return checker.getTypeFromTypeNode(shapeNode);
  }
  if (ts.isCallExpression(callExpression.expression)) {
    return extractServiceShapeTypeFromTagCall(
      checker,
      callExpression.expression
    );
  }
  return null;
}

function collectReferencedLocalSymbols(
  checker,
  currentNode,
  sourceFile,
  bucket
) {
  if (ts.isIdentifier(currentNode)) {
    const resolved = symbolAtNode(checker, currentNode);
    if (
      resolved &&
      (resolved.declarations ?? []).some(
        (declaration) => declaration.getSourceFile() === sourceFile
      )
    ) {
      bucket.add(resolved);
    }
  }
  ts.forEachChild(currentNode, (childNode) => {
    collectReferencedLocalSymbols(checker, childNode, sourceFile, bucket);
  });
}

function extractEffectSuccessType(checker, candidateType) {
  const symbolName =
    candidateType.aliasSymbol?.escapedName ??
    candidateType.symbol?.escapedName ??
    "";
  if (symbolName === "Effect") {
    const aliasArgs = candidateType.aliasTypeArguments;
    if (aliasArgs && aliasArgs.length > 0) {
      return aliasArgs[0];
    }
    const typeArgs = checker.getTypeArguments(candidateType);
    if (typeArgs.length > 0) {
      return typeArgs[0];
    }
  }
  const typeArgs =
    candidateType.objectFlags & ts.ObjectFlags.Reference
      ? checker.getTypeArguments(candidateType)
      : [];
  if (
    typeArgs.length >= 1 &&
    checker
      .getPropertiesOfType(candidateType)
      .some((property) => property.name.includes("EffectTypeId"))
  ) {
    return typeArgs[0];
  }
  return null;
}

function inspectServiceTagDeclarations(checker, sourceFile) {
  const serviceShapes = [];
  const wiredSymbols = new Set();
  const stack = [...sourceFile.statements];
  while (stack.length > 0) {
    const currentNode = stack.pop();
    const heritageCalls = ts.isClassDeclaration(currentNode)
      ? (currentNode.heritageClauses ?? []).flatMap((clause) =>
          clause.types
            .map((heritageType) => heritageType.expression)
            .filter(
              (expression) =>
                ts.isCallExpression(expression) && isServiceTagCall(expression)
            )
        )
      : [];
    for (const heritageCall of heritageCalls) {
      const shapeType = extractServiceShapeTypeFromTagCall(
        checker,
        heritageCall
      );
      if (shapeType) {
        serviceShapes.push(shapeType);
      }
      for (const argument of heritageCall.arguments.filter(
        ts.isObjectLiteralExpression
      )) {
        collectReferencedLocalSymbols(
          checker,
          argument,
          sourceFile,
          wiredSymbols
        );
      }
    }
    if (
      ts.isVariableDeclaration(currentNode) &&
      currentNode.initializer &&
      ts.isCallExpression(currentNode.initializer)
    ) {
      if (isServiceTagCall(currentNode.initializer)) {
        const shapeType = extractServiceShapeTypeFromTagCall(
          checker,
          currentNode.initializer
        );
        if (shapeType) {
          serviceShapes.push(shapeType);
        }
      }
    }
    if (
      ts.isCallExpression(currentNode) &&
      isLayerConstructionCall(currentNode)
    ) {
      const providerArguments =
        currentNode.arguments.length >= 2
          ? currentNode.arguments.slice(1)
          : currentNode.arguments;
      for (const argument of providerArguments) {
        collectReferencedLocalSymbols(
          checker,
          argument,
          sourceFile,
          wiredSymbols
        );
      }
    }
    ts.forEachChild(currentNode, (childNode) => {
      stack.push(childNode);
    });
  }
  return { serviceShapes, wiredSymbols };
}

export function serviceContractProvenance(program, sourceFile) {
  const byFile = serviceContractsByProgram.get(program) ?? new WeakMap();
  serviceContractsByProgram.set(program, byFile);
  if (byFile.has(sourceFile)) {
    return byFile.get(sourceFile);
  }
  const checker = program.getTypeChecker();
  const { serviceShapes, wiredSymbols } = inspectServiceTagDeclarations(
    checker,
    sourceFile
  );
  const hasServiceContract = serviceShapes.length > 0 || wiredSymbols.size > 0;
  const constructorSymbols = new Set();
  if (hasServiceContract) {
    const sameShape = shapeComparison(program);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const candidates = new Set(wiredSymbols);
    for (const exported of moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol)
      : []) {
      const resolved = resolveAliasedSymbol(checker, exported);
      if (resolved) {
        candidates.add(resolved);
      }
    }
    for (const candidateSymbol of candidates) {
      const declaration =
        candidateSymbol.valueDeclaration ?? candidateSymbol.declarations?.[0];
      if (!declaration || declaration.getSourceFile() !== sourceFile) {
        continue;
      }
      if (
        ts.isClassDeclaration(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          (isServiceTagCall(declaration.initializer) ||
            isLayerConstructionCall(declaration.initializer)))
      ) {
        continue;
      }
      const symbolType = checker.getTypeOfSymbolAtLocation(
        candidateSymbol,
        declaration
      );
      const callSignatures = checker.getSignaturesOfType(
        symbolType,
        ts.SignatureKind.Call
      );
      if (callSignatures.length === 0) {
        continue;
      }
      if (wiredSymbols.has(candidateSymbol)) {
        constructorSymbols.add(candidateSymbol);
        continue;
      }
      for (const signature of callSignatures) {
        const returnType = checker.getReturnTypeOfSignature(signature);
        const unwrappedReturn =
          extractEffectSuccessType(checker, returnType) ?? returnType;
        if (
          checker.getPropertiesOfType(unwrappedReturn).length > 0 &&
          serviceShapes.some(
            (serviceShape) => sameShape(unwrappedReturn, serviceShape) === true
          )
        ) {
          constructorSymbols.add(candidateSymbol);
          break;
        }
      }
    }
  }
  const provenance = {
    hasServiceContract,
    constructorSymbols,
  };
  byFile.set(sourceFile, provenance);
  return provenance;
}
