const typeCheckerBySourceCode = new WeakMap();

const SYMBOL_FLAG_OPTIONAL = 16_777_216;
const TYPE_FLAG_ANY = 1;
const TYPE_FLAG_UNKNOWN = 2;

export function getTypeServices(sourceCode) {
  const services = sourceCode?.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) return null;
  let checker = typeCheckerBySourceCode.get(sourceCode);
  if (!checker) {
    checker = services.program.getTypeChecker();
    typeCheckerBySourceCode.set(sourceCode, checker);
  }
  return {
    checker,
    nodeMap: services.esTreeNodeToTSNodeMap,
    program: services.program,
  };
}

export function hasTypeChecker(sourceCode) {
  return getTypeServices(sourceCode) !== null;
}

export function getResolvedType(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const tsNode = node ? services?.nodeMap.get(node) : null;
  if (!tsNode) return null;
  if (
    typeof node.type === "string" &&
    node.type.startsWith("TS") &&
    typeof services.checker.getTypeFromTypeNode === "function"
  ) {
    const fromTypeNode = services.checker.getTypeFromTypeNode(tsNode);
    if (fromTypeNode && (fromTypeNode.flags & TYPE_FLAG_ANY) === 0) {
      return fromTypeNode;
    }
  }
  return services.checker.getTypeAtLocation(tsNode);
}

function typeConstituents(type) {
  return type?.isUnion?.() ? (type.types ?? [type]) : [type];
}

export function resolvedTypeTexts(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (!type || !services) return null;
  return typeConstituents(type).map((constituent) =>
    services.checker.typeToString(constituent)
  );
}

function namedSymbol(symbol) {
  return symbol && !symbol.name.startsWith("__") ? symbol : null;
}

export function resolvedDeclarationFiles(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const tsNode = node ? services?.nodeMap.get(node) : null;
  if (!tsNode || !services) return [];
  const { checker } = services;
  const type = getResolvedType(node, sourceCode);
  const symbols = typeConstituents(type).flatMap((constituent) => [
    namedSymbol(constituent?.aliasSymbol),
    namedSymbol(constituent?.getSymbol?.()),
  ]);
  symbols.push(namedSymbol(checker.getSymbolAtLocation(tsNode)));
  return symbols.flatMap((symbol) =>
    (symbol?.declarations ?? []).flatMap((declaration) => {
      const fileName = declaration.getSourceFile?.()?.fileName;
      return typeof fileName === "string" ? [fileName] : [];
    })
  );
}

function isFirstPartyPropertySymbol(prop, program) {
  const declarations = prop?.declarations ?? [];
  if (declarations.length === 0) return false;
  return declarations.some((decl) => {
    const sf = decl.getSourceFile?.();
    const fileName = (sf?.fileName ?? "").replaceAll("\\", "/");
    return (
      Boolean(fileName) &&
      !fileName.includes("/node_modules/") &&
      !program.isSourceFileDefaultLibrary?.(sf)
    );
  });
}

export function resolvedOwnedPropertyNames(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (!type || !services) return null;
  const properties = services.checker.getPropertiesOfType(type) ?? [];
  return properties
    .filter(
      (prop) =>
        typeof prop?.name === "string" &&
        !prop.name.startsWith("__") &&
        isFirstPartyPropertySymbol(prop, services.program)
    )
    .map((prop) => prop.name);
}

export function resolvedPropertyShape(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (!type || !services) return null;
  const properties = services.checker.getPropertiesOfType(type) ?? [];
  const all = [];
  const required = [];
  for (const prop of properties) {
    if (typeof prop?.name !== "string" || prop.name.startsWith("__")) continue;
    all.push(prop.name);
    if (((prop.flags ?? 0) & SYMBOL_FLAG_OPTIONAL) === 0) {
      required.push(prop.name);
    }
  }
  return { all, required };
}

export function isBroadResolvedType(node, sourceCode) {
  const services = getTypeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (!type || !services) return false;
  const flags = type.flags ?? 0;
  if ((flags & (TYPE_FLAG_ANY | TYPE_FLAG_UNKNOWN)) !== 0) return true;
  if (type.isTypeParameter?.()) {
    const constraint = services.checker.getBaseConstraintOfType?.(type);
    return !constraint;
  }
  const text = services.checker.typeToString(type);
  if (text === "object" || text === "{}") return true;
  const indexInfos = services.checker.getIndexInfosOfType?.(type) ?? [];
  const properties = services.checker.getPropertiesOfType(type) ?? [];
  return indexInfos.length > 0 && properties.length === 0;
}

export function closedStringLiteralUnionValues(node, sourceCode) {
  const type = getResolvedType(node, sourceCode);
  if (!type) return null;
  const constituents = typeConstituents(type).filter((constituent) => {
    const text = constituent?.intrinsicName;
    return text !== "undefined" && text !== "null";
  });
  if (constituents.length === 0) return null;
  const literals = [];
  for (const constituent of constituents) {
    if (
      !constituent?.isStringLiteral?.() ||
      typeof constituent.value !== "string"
    ) {
      return null;
    }
    literals.push(constituent.value);
  }
  return literals;
}
