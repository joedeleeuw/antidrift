const typeCheckerBySourceCode = new WeakMap();

function typeServices(sourceCode) {
  const services = sourceCode?.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) return null;
  let checker = typeCheckerBySourceCode.get(sourceCode);
  if (!checker) {
    checker = services.program.getTypeChecker();
    typeCheckerBySourceCode.set(sourceCode, checker);
  }
  return { checker, nodeMap: services.esTreeNodeToTSNodeMap };
}

export function hasTypeChecker(sourceCode) {
  return typeServices(sourceCode) !== null;
}

function getResolvedType(node, sourceCode) {
  const services = typeServices(sourceCode);
  const tsNode = node ? services?.nodeMap.get(node) : null;
  return tsNode ? services.checker.getTypeAtLocation(tsNode) : null;
}

function typeConstituents(type) {
  return type?.isUnion() ? type.types : [type];
}

export function resolvedTypeTexts(node, sourceCode) {
  const services = typeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (!type) return null;
  return typeConstituents(type).map((constituent) =>
    services.checker.typeToString(constituent)
  );
}

function namedSymbol(symbol) {
  return symbol && !symbol.name.startsWith("__") ? symbol : null;
}

export function resolvedDeclarationFiles(node, sourceCode) {
  const services = typeServices(sourceCode);
  const tsNode = node ? services?.nodeMap.get(node) : null;
  if (!tsNode) return [];
  const { checker } = services;
  const type = checker.getTypeAtLocation(tsNode);
  const symbols = typeConstituents(type).flatMap((constituent) => [
    namedSymbol(constituent.aliasSymbol),
    namedSymbol(constituent.getSymbol()),
  ]);
  symbols.push(namedSymbol(checker.getSymbolAtLocation(tsNode)));
  return symbols.flatMap((symbol) =>
    (symbol?.declarations ?? []).flatMap((declaration) => {
      const fileName = declaration.getSourceFile?.()?.fileName;
      return typeof fileName === "string" ? [fileName] : [];
    })
  );
}
