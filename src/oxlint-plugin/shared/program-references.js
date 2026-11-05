const SYMBOL_FLAG_ALIAS = 2_097_152;
const IGNORED_SOURCE_FILE_RE =
  /(?:^|\/)(?:node_modules|dist|build|coverage|_generated)\/|\.d\.[cm]?ts$/u;

const referenceIndexByProgram = new WeakMap();

export function normalizedPath(fileName) {
  return fileName.replaceAll("\\", "/");
}

export function workspaceSourceFiles(program) {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        !IGNORED_SOURCE_FILE_RE.test(normalizedPath(sourceFile.fileName))
    );
}

export function isStaticElementName(tsNode) {
  return (
    typeof tsNode?.text === "string" &&
    tsNode.escapedText === undefined &&
    tsNode.expression === undefined &&
    tsNode.parent?.argumentExpression === tsNode
  );
}

function addToBucket(map, key, entry) {
  const bucket = map.get(key);
  if (bucket) bucket.push(entry);
  else map.set(key, [entry]);
}

function isDynamicElementKey(tsNode) {
  return (
    tsNode.parent?.argumentExpression === tsNode &&
    tsNode.parent.expression !== undefined &&
    !isStaticElementName(tsNode)
  );
}

function collectNames(tsNode, index) {
  if (typeof tsNode.escapedText === "string" || isStaticElementName(tsNode)) {
    addToBucket(index.namesByText, tsNode.text, tsNode);
  }
  if (isDynamicElementKey(tsNode)) index.dynamicKeys.push(tsNode);
  tsNode.forEachChild((child) => {
    collectNames(child, index);
  });
}

export function rootSymbols(symbol, checker) {
  if (!symbol) return [];
  const target =
    (symbol.flags & SYMBOL_FLAG_ALIAS) === 0
      ? symbol
      : checker.getAliasedSymbol(symbol);
  const roots = checker
    .getRootSymbols(checker.getExportSymbolOfSymbol(target))
    .map((root) => checker.getExportSymbolOfSymbol(root));
  return [...new Set(roots)];
}

function bindingPropertySymbol(tsNode, checker) {
  const binding = tsNode.parent;
  const pattern = binding?.parent;
  if (
    binding?.name !== tsNode ||
    binding.propertyName ||
    !Array.isArray(pattern?.elements) ||
    !pattern.getText().startsWith("{")
  ) {
    return undefined;
  }
  return checker.getPropertyOfType(
    checker.getTypeAtLocation(pattern),
    tsNode.text
  );
}

function referenceSymbol(tsNode, checker) {
  const shorthand = checker.getShorthandAssignmentValueSymbol(tsNode.parent);
  if (shorthand) return shorthand;
  const bindingProperty = bindingPropertySymbol(tsNode, checker);
  if (bindingProperty) return bindingProperty;
  return checker.getSymbolAtLocation(tsNode);
}

function isMemberName(tsNode) {
  const parent = tsNode.parent;
  return (
    (parent?.name === tsNode && parent.expression !== undefined) ||
    parent?.argumentExpression === tsNode
  );
}

function resolveBucket(index, text, checker) {
  if (index.resolvedTexts.has(text)) return;
  index.resolvedTexts.add(text);
  for (const tsNode of index.namesByText.get(text) ?? []) {
    const roots = rootSymbols(referenceSymbol(tsNode, checker), checker);
    if (roots.length === 0 && isMemberName(tsNode)) {
      index.unresolvedMemberTexts.add(text);
    }
    for (const root of roots) {
      addToBucket(index.referencesByRoot, root, tsNode);
      if (roots.length > 1) index.ambiguousRoots.add(root);
    }
  }
}

export function programIndex(services) {
  const { program } = services;
  let index = referenceIndexByProgram.get(program);
  if (!index) {
    index = {
      namesByText: new Map(),
      resolvedTexts: new Set(),
      referencesByRoot: new Map(),
      ambiguousRoots: new Set(),
      unresolvedMemberTexts: new Set(),
      dynamicKeys: [],
      dynamicKeyNames: null,
      exposure: null,
    };
    for (const sourceFile of workspaceSourceFiles(program)) {
      collectNames(sourceFile, index);
    }
    referenceIndexByProgram.set(program, index);
  }
  return index;
}

export function declarationRoot(nameNode, checker) {
  const roots = rootSymbols(checker.getSymbolAtLocation(nameNode), checker);
  return roots.length === 1 ? roots[0] : null;
}

function moduleBindingSpecifier(tsNode) {
  const specifier = tsNode.parent;
  const isSpecifier =
    Array.isArray(specifier?.parent?.elements) &&
    (specifier.name === tsNode || specifier.propertyName === tsNode);
  if (!isSpecifier) return null;
  const bindingOwner = specifier.parent.parent;
  if (bindingOwner && "exportClause" in bindingOwner) {
    return { specifier, exported: true };
  }
  return bindingOwner?.parent && "importClause" in bindingOwner.parent
    ? { specifier, exported: false }
    : null;
}

export function programReferences(nameNode, services) {
  const { checker } = services;
  const target = declarationRoot(nameNode, checker);
  if (!target) return null;
  const index = programIndex(services);
  const texts = new Set([nameNode.text]);
  let references = [];
  let pending = true;
  while (pending) {
    pending = false;
    for (const text of texts) resolveBucket(index, text, checker);
    references = index.referencesByRoot.get(target) ?? [];
    for (const reference of references) {
      const binding = moduleBindingSpecifier(reference);
      const alias = binding?.specifier.name?.text;
      if (alias === "default" && binding.exported) return null;
      if (alias && !texts.has(alias)) {
        texts.add(alias);
        pending = true;
      }
    }
  }
  if (index.ambiguousRoots.has(target)) return null;
  return references.filter(
    (reference) => reference !== nameNode && !moduleBindingSpecifier(reference)
  );
}

function isHeritageReference(reference) {
  const heritageType = reference.parent;
  return (
    heritageType?.expression === reference &&
    Array.isArray(heritageType.parent?.types) &&
    heritageType.parent.token !== undefined
  );
}

function receiverAcceptsInstance(reference, instanceType, checker) {
  const access = reference.parent;
  const receiver = access?.expression;
  return (
    receiver !== undefined &&
    receiver !== reference &&
    checker.isTypeAssignableTo(
      instanceType,
      checker.getTypeAtLocation(receiver)
    )
  );
}

function literalKeyNames(keyNode, checker) {
  const type = checker.getTypeAtLocation(keyNode);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => part.isLiteral())
    ? new Set(parts.map((part) => String(part.value)))
    : null;
}

function dynamicKeysNaming(text, index, checker) {
  index.dynamicKeyNames ??= index.dynamicKeys.map((keyNode) => ({
    keyNode,
    names: literalKeyNames(keyNode, checker),
  }));
  return index.dynamicKeyNames
    .filter(({ names }) => names === null || names.has(text))
    .map(({ keyNode }) => keyNode);
}

export function isMemberDispatchClosed(
  methodNameNode,
  classNameNode,
  services
) {
  const { checker } = services;
  const index = programIndex(services);
  const classReferences = programReferences(classNameNode, services);
  const method = declarationRoot(methodNameNode, checker);
  if (!classReferences || !method) return false;
  if (classReferences.some(isHeritageReference)) return false;
  const text = methodNameNode.text;
  resolveBucket(index, text, checker);
  if (index.unresolvedMemberTexts.has(text)) return false;
  const instanceType = checker.getDeclaredTypeOfSymbol(
    declarationRoot(classNameNode, checker)
  );
  if (
    dynamicKeysNaming(text, index, checker).some((keyNode) =>
      receiverAcceptsInstance(keyNode, instanceType, checker)
    )
  ) {
    return false;
  }
  const sameRoot = new Set(index.referencesByRoot.get(method) ?? []);
  return (index.namesByText.get(text) ?? []).every(
    (reference) =>
      sameRoot.has(reference) ||
      !isMemberName(reference) ||
      !receiverAcceptsInstance(reference, instanceType, checker)
  );
}
