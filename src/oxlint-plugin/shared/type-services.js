const typeCheckerBySourceCode = new WeakMap();

const SYMBOL_FLAG_ALIAS = 2_097_152;
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

export function isErrorResolvedType(node, sourceCode) {
  return getResolvedType(node, sourceCode)?.intrinsicName === "error";
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

function resolveAliasSymbol(symbol, checker) {
  const named = namedSymbol(symbol);
  if (
    !named ||
    (named.flags & SYMBOL_FLAG_ALIAS) === 0 ||
    typeof checker.getAliasedSymbol !== "function"
  ) {
    return named;
  }
  try {
    const resolved = checker.getAliasedSymbol(named);
    return resolved && resolved !== named && resolved.name !== "unknown"
      ? namedSymbol(resolved)
      : null;
  } catch {
    return null;
  }
}

function isImportSyntaxDeclaration(declaration) {
  for (let current = declaration; current; current = current.parent) {
    if (
      current.moduleSpecifier ||
      current.moduleReference ||
      current.importClause
    ) {
      return true;
    }
  }
  return false;
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
  return symbols.flatMap((symbol) => {
    const resolved = resolveAliasSymbol(symbol, checker);
    return (resolved?.declarations ?? []).flatMap((declaration) => {
      if (isImportSyntaxDeclaration(declaration)) return [];
      const fileName = declaration.getSourceFile?.()?.fileName;
      return typeof fileName === "string" ? [fileName] : [];
    });
  });
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

function isStructuralPropertySymbol(prop, program, ownedOnly) {
  if (ownedOnly) return isFirstPartyPropertySymbol(prop, program);
  return (prop?.declarations ?? []).some((declaration) => {
    const sourceFile = declaration.getSourceFile?.();
    return sourceFile && !program.isSourceFileDefaultLibrary?.(sourceFile);
  });
}

export function isOptionalProperty(property) {
  return (property.flags & SYMBOL_FLAG_OPTIONAL) !== 0;
}

export function firstPartyContract(type, services) {
  if (
    !type ||
    type.isUnion?.() ||
    !type.objectFlags ||
    type.declaration?.typeParameter
  ) {
    return null;
  }
  const symbol =
    namedSymbol(type.aliasSymbol) ?? namedSymbol(type.getSymbol?.());
  if (!symbol || !isFirstPartyPropertySymbol(symbol, services.program)) {
    return null;
  }
  return {
    type,
    symbol,
    name: symbol.name,
    properties: services.checker
      .getPropertiesOfType(type)
      .filter((property) =>
        isFirstPartyPropertySymbol(property, services.program)
      ),
  };
}

export function propertyType(property, services) {
  const declaration = property.declarations?.[0];
  return declaration
    ? services.checker.getTypeOfSymbolAtLocation(property, declaration)
    : null;
}

export function isEntityIdentityKey(key) {
  return /^(?:id|slug|number)$|(?:Id|ID)$/u.test(key);
}

export function shareEntityIdentity(left, right, services) {
  return left.properties.some((property) => {
    if (!isEntityIdentityKey(property.name)) return false;
    const peer = right.properties.find(
      (candidate) => candidate.name === property.name
    );
    if (!peer) return false;
    const leftType = propertyType(property, services);
    const rightType = propertyType(peer, services);
    return (
      leftType &&
      rightType &&
      services.checker.isTypeAssignableTo(leftType, rightType) &&
      services.checker.isTypeAssignableTo(rightType, leftType)
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

export function resolvedPropertyShape(node, sourceCode, options = {}) {
  const services = getTypeServices(sourceCode);
  const type = getResolvedType(node, sourceCode);
  if (
    !type ||
    !services ||
    type.intrinsicName === "error" ||
    (type.flags & (TYPE_FLAG_ANY | TYPE_FLAG_UNKNOWN)) !== 0 ||
    type.isUnion?.() ||
    !type.objectFlags
  ) {
    return null;
  }
  const { ownedOnly = false } = options;
  const properties = services.checker.getPropertiesOfType(type) ?? [];
  const all = [];
  const required = [];
  for (const prop of properties) {
    if (
      typeof prop?.name !== "string" ||
      prop.name.startsWith("__") ||
      !isStructuralPropertySymbol(prop, services.program, ownedOnly)
    ) {
      continue;
    }
    all.push(prop.name);
    if (!isOptionalProperty(prop)) {
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
