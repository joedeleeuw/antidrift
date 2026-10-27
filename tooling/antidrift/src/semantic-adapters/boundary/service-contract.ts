import ts from "typescript";

import { isTypeReference } from "../kernel/typescript-internals.ts";
import {
  resolveAliasedSymbol,
  symbolAtNode,
} from "../provenance/symbol-provenance.ts";

type ServiceTagScan = {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly serviceShapes: ts.Type[];
  readonly wiredSymbols: Set<ts.Symbol>;
};

type ServiceContractProvenance = {
  readonly hasServiceContract: boolean;
  readonly constructorSymbols: ReadonlySet<ts.Symbol>;
};

const serviceContractsByProgram = new WeakMap<
  ts.Program,
  WeakMap<ts.SourceFile, ServiceContractProvenance>
>();

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

function calleeNamespaceAndMethod(
  expression: ts.Expression
): { namespaceName: string | null; methodName: string } | null {
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
    return { namespaceName: null, methodName: expression.text };
  }
  return null;
}

function isServiceTagCall(callExpression: ts.CallExpression): boolean {
  const direct = calleeNamespaceAndMethod(callExpression.expression);
  if (
    direct &&
    SERVICE_TAG_FACTORIES.has(direct.methodName) &&
    (!direct.namespaceName || SERVICE_TAG_NAMESPACES.has(direct.namespaceName))
  ) {
    return true;
  }
  return (
    ts.isCallExpression(callExpression.expression) &&
    isServiceTagCall(callExpression.expression)
  );
}

export function isLayerConstructionCall(
  callExpression: ts.CallExpression
): boolean {
  const direct = calleeNamespaceAndMethod(callExpression.expression);
  return (
    direct?.namespaceName === "Layer" &&
    LAYER_FACTORY_METHODS.has(direct.methodName)
  );
}

function extractServiceShapeTypeFromTagCall(
  checker: ts.TypeChecker,
  callExpression: ts.CallExpression
): ts.Type | null {
  const shapeNode =
    callExpression.typeArguments?.[1] ?? callExpression.typeArguments?.[0];
  if (shapeNode) {
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
  scan: ServiceTagScan,
  currentNode: ts.Node
): void {
  if (ts.isIdentifier(currentNode)) {
    const resolved = symbolAtNode(scan.checker, currentNode);
    if (
      resolved &&
      (resolved.declarations ?? []).some(
        (declaration) => declaration.getSourceFile() === scan.sourceFile
      )
    ) {
      scan.wiredSymbols.add(resolved);
    }
  }
  ts.forEachChild(currentNode, (childNode) => {
    collectReferencedLocalSymbols(scan, childNode);
  });
}

function extractEffectSuccessType(
  checker: ts.TypeChecker,
  candidateType: ts.Type
): ts.Type | null {
  const symbolName =
    candidateType.aliasSymbol?.name ?? candidateType.getSymbol()?.name;
  if (symbolName === "Effect") {
    const aliasArgument = candidateType.aliasTypeArguments?.[0];
    if (aliasArgument) {
      return aliasArgument;
    }
    const typeArgument = isTypeReference(candidateType)
      ? checker.getTypeArguments(candidateType)[0]
      : undefined;
    if (typeArgument) {
      return typeArgument;
    }
  }
  const typeArgument = isTypeReference(candidateType)
    ? checker.getTypeArguments(candidateType)[0]
    : undefined;
  if (
    typeArgument &&
    checker
      .getPropertiesOfType(candidateType)
      .some((property) => property.name.includes("EffectTypeId"))
  ) {
    return typeArgument;
  }
  return null;
}

function heritageServiceTagCalls(
  declaration: ts.ClassDeclaration
): ts.CallExpression[] {
  return (declaration.heritageClauses ?? []).flatMap((clause) =>
    clause.types.flatMap((heritageType) =>
      ts.isCallExpression(heritageType.expression) &&
      isServiceTagCall(heritageType.expression)
        ? [heritageType.expression]
        : []
    )
  );
}

function serviceTagShapeCalls(currentNode: ts.Node): ts.CallExpression[] {
  if (ts.isClassDeclaration(currentNode)) {
    return heritageServiceTagCalls(currentNode);
  }
  if (
    ts.isVariableDeclaration(currentNode) &&
    currentNode.initializer &&
    ts.isCallExpression(currentNode.initializer) &&
    isServiceTagCall(currentNode.initializer)
  ) {
    return [currentNode.initializer];
  }
  return [];
}

function serviceWiring(
  currentNode: ts.Node
): {
  roots: readonly ts.Node[];
  serviceTag?: ts.Expression | undefined;
} | null {
  if (ts.isClassDeclaration(currentNode)) {
    return {
      roots: heritageServiceTagCalls(currentNode).flatMap((heritageCall) =>
        heritageCall.arguments.filter(ts.isObjectLiteralExpression)
      ),
    };
  }
  if (
    ts.isCallExpression(currentNode) &&
    isLayerConstructionCall(currentNode)
  ) {
    return {
      roots:
        currentNode.arguments.length >= 2
          ? currentNode.arguments.slice(1)
          : currentNode.arguments,
      serviceTag:
        currentNode.arguments.length >= 2
          ? currentNode.arguments[0]
          : undefined,
    };
  }
  return null;
}

function serviceShapeFromWiringTag(
  checker: ts.TypeChecker,
  serviceTag: ts.Expression
): ts.Type | null {
  const serviceProperty = checker
    .getTypeAtLocation(serviceTag)
    .getProperty("Service");
  return serviceProperty
    ? checker.getTypeOfSymbolAtLocation(serviceProperty, serviceTag)
    : null;
}

function inspectServiceTagDeclarations(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): ServiceTagScan {
  const scan: ServiceTagScan = {
    checker,
    sourceFile,
    serviceShapes: [],
    wiredSymbols: new Set(),
  };
  const stack: ts.Node[] = [...sourceFile.statements];
  for (let currentNode = stack.pop(); currentNode; currentNode = stack.pop()) {
    for (const shapeCall of serviceTagShapeCalls(currentNode)) {
      const shapeType = extractServiceShapeTypeFromTagCall(checker, shapeCall);
      if (shapeType) {
        scan.serviceShapes.push(shapeType);
      }
    }
    const wiring = serviceWiring(currentNode);
    if (wiring) {
      for (const wiringRoot of wiring.roots) {
        collectReferencedLocalSymbols(scan, wiringRoot);
      }
      if (wiring.serviceTag) {
        const shapeType = serviceShapeFromWiringTag(checker, wiring.serviceTag);
        if (shapeType) {
          scan.serviceShapes.push(shapeType);
        }
      }
    }
    ts.forEachChild(currentNode, (childNode) => {
      stack.push(childNode);
    });
  }
  return scan;
}

function isWiringDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isClassDeclaration(declaration) ||
    (ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isCallExpression(declaration.initializer) &&
      (isServiceTagCall(declaration.initializer) ||
        isLayerConstructionCall(declaration.initializer)))
  );
}

function isServiceConstructor(
  scan: ServiceTagScan,
  candidateSymbol: ts.Symbol
): boolean {
  const { checker } = scan;
  const declaration =
    candidateSymbol.valueDeclaration ?? candidateSymbol.declarations?.[0];
  if (
    !declaration ||
    declaration.getSourceFile() !== scan.sourceFile ||
    isWiringDeclaration(declaration)
  ) {
    return false;
  }
  const callSignatures = checker.getSignaturesOfType(
    checker.getTypeOfSymbolAtLocation(candidateSymbol, declaration),
    ts.SignatureKind.Call
  );
  if (callSignatures.length === 0) {
    return false;
  }
  return callSignatures.some((signature) => {
    const returnType = checker.getReturnTypeOfSignature(signature);
    const unwrappedReturn =
      extractEffectSuccessType(checker, returnType) ?? returnType;
    return (
      checker.getPropertiesOfType(unwrappedReturn).length > 0 &&
      scan.serviceShapes.some(
        (serviceShape) =>
          checker.getPropertiesOfType(serviceShape).length > 0 &&
          checker.isTypeAssignableTo(unwrappedReturn, serviceShape)
      )
    );
  });
}

function inspectServiceContract(
  program: ts.Program,
  sourceFile: ts.SourceFile
): ServiceContractProvenance {
  const checker = program.getTypeChecker();
  const scan = inspectServiceTagDeclarations(checker, sourceFile);
  const hasServiceContract =
    scan.serviceShapes.length > 0 || scan.wiredSymbols.size > 0;
  if (!hasServiceContract) {
    return { hasServiceContract, constructorSymbols: new Set() };
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const candidates = new Set(scan.wiredSymbols);
  for (const exported of moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol)
    : []) {
    const resolved = resolveAliasedSymbol(checker, exported);
    if (resolved) {
      candidates.add(resolved);
    }
  }
  return {
    hasServiceContract,
    constructorSymbols: new Set(
      [...candidates].filter((candidateSymbol) =>
        isServiceConstructor(scan, candidateSymbol)
      )
    ),
  };
}

export function serviceContractProvenance(
  program: ts.Program,
  sourceFile: ts.SourceFile
): ServiceContractProvenance {
  const byFile =
    serviceContractsByProgram.get(program) ??
    new WeakMap<ts.SourceFile, ServiceContractProvenance>();
  serviceContractsByProgram.set(program, byFile);
  const cached = byFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const provenance = inspectServiceContract(program, sourceFile);
  byFile.set(sourceFile, provenance);
  return provenance;
}
