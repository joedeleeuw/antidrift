import ts from "typescript";
import {
  boundedType,
  dataProperty,
  equivalentType,
  objectType,
  propertyModifiers,
} from "./contract-types.mjs";

const cache = new WeakMap();
const maxDepth = 8;

function nonNullable(checker, type) {
  return type && checker.getNonNullableType(type);
}

function propertyType(checker, type, name) {
  const property = checker.getPropertyOfType(type, name);
  return property && checker.getTypeOfSymbol(property);
}

function finiteStrings(type) {
  const parts = type?.isUnion() ? type.types : [type];
  return parts.length && parts.every((part) => part?.isStringLiteral())
    ? new Set(parts.map((part) => part.value))
    : null;
}

function sameSet(left, right) {
  return Boolean(
    left &&
    right &&
    left.size === right.size &&
    [...left].every((value) => right.has(value)),
  );
}

function valueSymbol(checker, node) {
  return ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
}

function valuePath(checker, expression) {
  if (ts.isParenthesizedExpression(expression)) {
    return valuePath(checker, expression.expression);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = valueSymbol(checker, expression);
    return symbol ? { symbol, path: [] } : null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    !expression.questionDotToken
  ) {
    const root = valuePath(checker, expression.expression);
    return (
      root && {
        symbol: root.symbol,
        path: [...root.path, expression.name.text],
      }
    );
  }
  return null;
}

function samePath(left, right) {
  return (
    left?.symbol === right?.symbol &&
    left?.path.join(".") === right?.path.join(".")
  );
}

function ownerProjections(checker, candidates) {
  const owners = new Map();
  function visit(type, candidate, label, depth, seen) {
    type = nonNullable(checker, type);
    if (!objectType(type) || depth === 0 || seen.has(type)) return;
    // Labels describe evidence; they are not competing type identities. Preserve
    // every accepted route to this exact checker type instead of picking a label.
    const existing = owners.get(type);
    const sources = existing?.sources ?? new Map();
    sources.set(`${candidate.authority}:${label}`, {
      authority: candidate.authority,
      label,
      root: candidate.type,
    });
    owners.set(type, {
      type,
      sources,
      roots: new Set([...sources.values()].map((source) => source.root)),
      authority: [
        ...new Set([...sources.values()].map((source) => source.authority)),
      ]
        .sort()
        .join(" | "),
      label: [...new Set([...sources.values()].map((source) => source.label))]
        .sort()
        .join(" | "),
    });
    const next = new Set([...seen, type]);
    for (const property of checker.getPropertiesOfType(type)) {
      visit(
        checker.getTypeOfSymbol(property),
        candidate,
        `${label}[${JSON.stringify(property.name)}]`,
        depth - 1,
        next,
      );
    }
  }
  for (const candidate of candidates) {
    if (candidate.authorityState === "accepted" && candidate.type) {
      visit(candidate.type, candidate, candidate.label, maxDepth, new Set());
    }
  }
  return owners;
}

function contextualOwner(checker, owners, type) {
  type = nonNullable(checker, type);
  const owner = owners.get(type);
  if (owner) return owner;
  if (!type?.isUnion() || !boundedType(checker, type)) return null;
  const objects = type.types.filter(
    (part) => part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection),
  );
  return objects.length === 1 ? owners.get(objects[0]) : null;
}

function declaredPathType(checker, path) {
  let type = checker.getTypeOfSymbol(path.symbol);
  for (const field of path.path) {
    if (!objectType(type)) return null;
    const property = checker.getPropertyOfType(type, field);
    if (!dataProperty(property)) return null;
    type = checker.getTypeOfSymbol(property);
  }
  return objectType(type) ? type : null;
}

// This is a certificate for one value binding, not a global equivalence between
// two aliases. Writes, aliases, and opaque escapes terminate that certificate.
function stableBridge(checker, bridge) {
  const declaration = bridge.symbol.valueDeclaration;
  if (
    !declaration ||
    (!ts.isParameter(declaration) &&
      !ts.isVariableDeclaration(declaration) &&
      !ts.isBindingElement(declaration))
  ) {
    return false;
  }
  let stable = true;
  function containsRoot(node) {
    if (ts.isIdentifier(node) && valueSymbol(checker, node) === bridge.symbol) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (containsRoot(child)) found = true;
    });
    return found;
  }
  function unsafeOperation(node) {
    if (ts.isBinaryExpression(node)) {
      return (
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        containsRoot(node.left)
      );
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return (
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        containsRoot(node.operand)
      );
    }
    if (
      ts.isDeleteExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node)
    ) {
      return containsRoot(node.expression);
    }
    return (
      ts.isPropertyAccessExpression(node) &&
      containsRoot(node.expression) &&
      !dataProperty(
        checker.getPropertyOfType(
          checker.getTypeAtLocation(node.expression),
          node.name.text,
        ),
      )
    );
  }
  function visit(node) {
    if (!stable) return;
    if (unsafeOperation(node)) {
      stable = false;
      return;
    }
    if (
      ts.isIdentifier(node) &&
      valueSymbol(checker, node) === bridge.symbol &&
      node !== declaration.name
    ) {
      let value = node;
      while (
        ts.isPropertyAccessExpression(value.parent) &&
        value.parent.expression === value
      ) {
        value = value.parent;
      }
      const path = valuePath(checker, value);
      if (path?.path.length <= bridge.path.length) {
        const parent = value.parent;
        const jsxUse =
          ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent);
        if (!jsxUse) stable = false;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration.getSourceFile());
  return stable;
}

function equalityGuard(checker, expression) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const pairs = [
    [expression.left, expression.right],
    [expression.right, expression.left],
  ];
  for (const [member, literal] of pairs) {
    if (
      !ts.isPropertyAccessExpression(member) ||
      member.questionDotToken ||
      !ts.isStringLiteral(literal)
    ) {
      continue;
    }
    const root = valuePath(checker, member.expression);
    if (root) return { ...root, field: member.name.text, value: literal.text };
  }
  return null;
}

function outputTag(expression, field) {
  if (ts.isParenthesizedExpression(expression)) {
    return outputTag(expression.expression, field);
  }
  if (!ts.isObjectLiteralExpression(expression)) return null;
  if (
    expression.properties.some(
      (member) =>
        ts.isSpreadAssignment(member) ||
        (member.name && ts.isComputedPropertyName(member.name)),
    )
  ) {
    return null;
  }
  const properties = expression.properties.filter(
    (member) =>
      member.name &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === field,
  );
  const property = properties.length === 1 ? properties[0] : null;
  return property &&
    ts.isPropertyAssignment(property) &&
    ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : null;
}

function discriminantBridge(checker, expression, owner) {
  if (!ts.isConditionalExpression(expression)) return null;
  const guard = equalityGuard(checker, expression.condition);
  if (!guard) return null;
  const binding = guard.symbol.valueDeclaration?.name;
  if (
    !binding ||
    !ts.isIdentifier(binding) ||
    !trustedSource(checker, binding)
  ) {
    return null;
  }
  const source = declaredPathType(checker, guard);
  if (
    !source ||
    !dataProperty(checker.getPropertyOfType(source, guard.field))
  ) {
    return null;
  }
  const sourceCases = finiteStrings(propertyType(checker, source, guard.field));
  const ownerCases = finiteStrings(
    propertyType(checker, owner.type, guard.field),
  );
  if (!sameSet(sourceCases, ownerCases) || sourceCases.size < 2) return null;
  const remaining = new Set(sourceCases);
  let branch = expression;
  while (ts.isConditionalExpression(branch)) {
    const current = equalityGuard(checker, branch.condition);
    if (
      !current ||
      !samePath(guard, current) ||
      current.field !== guard.field ||
      !remaining.has(current.value) ||
      outputTag(branch.whenTrue, guard.field) !== current.value
    ) {
      return null;
    }
    remaining.delete(current.value);
    branch = branch.whenFalse;
  }
  if (remaining.size !== 1 || !remaining.has(outputTag(branch, guard.field))) {
    return null;
  }
  return {
    symbol: guard.symbol,
    path: guard.path,
    field: guard.field,
    owner,
    site: expression,
  };
}

function trustedSource(checker, expression, seen = new Set()) {
  const path = valuePath(checker, expression);
  if (!path || seen.has(path.symbol)) return false;
  let declaration = path.symbol.valueDeclaration;
  if (!declaration) return false;
  while (ts.isBindingElement(declaration)) {
    declaration = declaration.parent.parent;
  }
  if (ts.isParameter(declaration)) return !declaration.initializer;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return false;
  }
  const initializer = declaration.initializer;
  if (
    ts.isAsExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer) ||
    checker.getTypeAtLocation(initializer).flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
  ) {
    return false;
  }
  if (ts.isCallExpression(initializer)) return true;
  return trustedSource(checker, initializer, new Set([...seen, path.symbol]));
}

function ownerTypes(checker, owner) {
  const visited = new Set();
  function visit(type, depth) {
    if (depth === 0 || visited.has(type)) return;
    visited.add(type);
    if (!objectType(type)) return;
    for (const property of checker.getPropertiesOfType(type)) {
      visit(nonNullable(checker, checker.getTypeOfSymbol(property)), depth - 1);
    }
  }
  for (const root of owner.roots) visit(root, maxDepth);
  return visited;
}

// A reference is a derivation only when it resolves back to an accepted owner.
// Primitive identity alone is insufficient: `type Text = string` owns no field.
function ownerReference(checker, node, owner, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  const next = new Set([...seen, node]);
  if (ts.isParenthesizedTypeNode(node)) {
    return ownerReference(checker, node.type, owner, next);
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    return ownerReference(checker, node.objectType, owner, next);
  }
  if (ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node)) {
    const type = checker.getTypeFromTypeNode(node);
    const ownedTypes = ownerTypes(checker, owner);
    // Primitive identity alone is globally shared; only an actual alias or
    // object identity can establish a direct owner reference.
    if ((objectType(type) || type.aliasSymbol) && ownedTypes.has(type)) {
      return true;
    }
    const properties = checker.getPropertiesOfType(type);
    if (
      properties.length &&
      [...ownedTypes].some(
        (owned) =>
          objectType(owned) &&
          properties.every((property) => {
            const original = checker.getPropertyOfType(owned, property.name);
            return (
              original &&
              property.declarations?.length &&
              property.declarations.every((declaration) =>
                original.declarations?.includes(declaration),
              )
            );
          }),
      )
    ) {
      return true;
    }
    let symbol = ts.isTypeReferenceNode(node)
      ? checker.getSymbolAtLocation(node.typeName)
      : type.aliasSymbol;
    if (symbol?.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return (symbol?.declarations ?? []).some(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) &&
        ownerReference(checker, declaration.type, owner, next),
    );
  }
  return false;
}

function derivedComposition(checker, node, owner) {
  if (ownerReference(checker, node, owner)) return true;
  if (ts.isParenthesizedTypeNode(node)) {
    return derivedComposition(checker, node.type, owner);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.every((part) => derivedComposition(checker, part, owner));
  }
  if (ts.isTypeLiteralNode(node)) {
    return (
      node.members.length > 0 &&
      node.members.every(
        (member) =>
          member.type && derivedComposition(checker, member.type, owner),
      )
    );
  }
  return false;
}

function handwritten(typeNode) {
  if (!typeNode) return false;
  if (ts.isParenthesizedTypeNode(typeNode)) return handwritten(typeNode.type);
  if (ts.isTypeLiteralNode(typeNode)) return true;
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.every(
      (part) => ts.isLiteralTypeNode(part) || handwritten(part),
    );
  }
  return false;
}

function handwrittenNode(checker, node, seen = new Set()) {
  if (handwritten(node)) return node;
  if (!node || !ts.isTypeReferenceNode(node)) return null;
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol?.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (!symbol || seen.has(symbol)) return null;
  const next = new Set([...seen, symbol]);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(declaration)) {
      const result = handwrittenNode(checker, declaration.type, next);
      if (result) return result;
    }
  }
  return null;
}

function localPropertyNode(checker, property, owner) {
  for (const declaration of property?.declarations ?? []) {
    if (!ts.isPropertySignature(declaration)) continue;
    if (derivedComposition(checker, declaration.type, owner)) continue;
    const node = handwrittenNode(checker, declaration.type);
    if (node && !derivedComposition(checker, node, owner)) return node;
  }
  return null;
}

function directTypeNode(type) {
  const declarations = type?.symbol?.declarations ?? [];
  return (
    declarations.find(
      (node) =>
        ts.isTypeLiteralNode(node) ||
        (ts.isInterfaceDeclaration(node) && !node.heritageClauses?.length),
    ) ?? null
  );
}

function sameProperty(checker, local, owner) {
  if (!local || !owner) return false;
  const left = propertyModifiers(local);
  const right = propertyModifiers(owner);
  if (
    left.optional !== right.optional ||
    left.readonly !== right.readonly ||
    left.method !== right.method
  ) {
    return false;
  }
  const localType = checker.getTypeOfSymbol(local);
  const ownerType = checker.getTypeOfSymbol(owner);
  return (
    boundedType(checker, localType) &&
    boundedType(checker, ownerType) &&
    equivalentType(checker, localType, ownerType)
  );
}

function projectionProof(checker, localType, owner, fields, site) {
  const props = fields.map((field) => [
    field,
    checker.typeToString(propertyType(checker, localType, field)),
  ]);
  return {
    authorityState: "accepted",
    diagnostic: { emitted: true, messageId: "ownedContractProjection" },
    localType: {
      name: localType.aliasSymbol?.name ?? "anonymous contract",
      props,
    },
    ownerType: { authority: owner.authority, label: owner.label, props },
    structuralMatch: {
      matchedProps: fields,
      relation: "proven-owner-projection",
      localPropCount: fields.length,
      ownerPropCount: checker.getPropertiesOfType(owner.type).length,
      provenance: {
        file: site.getSourceFile().fileName,
        start: site.getStart(),
      },
    },
  };
}

function collectLocalCopies(
  checker,
  local,
  owner,
  site,
  findings,
  onlyField,
  depth = maxDepth,
) {
  local = nonNullable(checker, local);
  if (!objectType(local) || depth === 0 || local === owner.type) return;
  const fields = checker.getPropertiesOfType(local);
  const matching = fields.filter(
    (field) =>
      (!onlyField || field.name === onlyField) &&
      sameProperty(
        checker,
        field,
        checker.getPropertyOfType(owner.type, field.name),
      ),
  );
  const literal = directTypeNode(local);
  if (
    !onlyField &&
    literal &&
    matching.length === fields.length &&
    fields.length === checker.getPropertiesOfType(owner.type).length &&
    fields.length > 0 &&
    literal.members.every(
      (member) =>
        ts.isPropertySignature(member) &&
        member.type &&
        !derivedComposition(checker, member.type, owner),
    )
  ) {
    findings.set(
      literal,
      projectionProof(
        checker,
        local,
        owner,
        fields.map((field) => field.name),
        site,
      ),
    );
    return;
  }
  for (const property of matching) {
    const node = localPropertyNode(checker, property, owner);
    if (
      node &&
      !node.getSourceFile().isDeclarationFile &&
      !node.getSourceFile().fileName.includes("/node_modules/")
    ) {
      findings.set(
        node,
        projectionProof(checker, local, owner, [property.name], site),
      );
    }
  }
  if (onlyField) return;
  for (const field of fields) {
    const ownerField = checker.getPropertyOfType(owner.type, field.name);
    if (
      !ownerField ||
      JSON.stringify(propertyModifiers(field)) !==
        JSON.stringify(propertyModifiers(ownerField))
    ) {
      continue;
    }
    const ownerType = nonNullable(checker, checker.getTypeOfSymbol(ownerField));
    if (!objectType(ownerType)) continue;
    collectLocalCopies(
      checker,
      checker.getTypeOfSymbol(field),
      {
        ...owner,
        type: ownerType,
        label: `${owner.label}[${JSON.stringify(field.name)}]`,
      },
      site,
      findings,
      null,
      depth - 1,
    );
  }
}

export function collectOwnedContractProvenance(program, checker, candidates) {
  const accepted = candidates.filter(
    (candidate) => candidate.authorityState === "accepted",
  );
  let programCache = cache.get(program);
  if (!programCache) {
    programCache = [];
    cache.set(program, programCache);
  }
  const cached = programCache.find(
    (entry) =>
      entry.candidates.length === accepted.length &&
      accepted.every(
        (candidate, index) =>
          candidate.type === entry.candidates[index].type &&
          candidate.label === entry.candidates[index].label &&
          candidate.authority === entry.candidates[index].authority,
      ),
  );
  if (cached) return cached.findings;
  const owners = ownerProjections(checker, candidates);
  const bridges = new Map();
  const findings = new Map();
  const files = program
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        !file.fileName.includes("/node_modules/") &&
        !file.fileName.includes("/convex/_generated/"),
    );
  function anchor(node) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return;
    if (ts.isConditionalExpression(node)) {
      const owner = owners.get(
        nonNullable(checker, checker.getContextualType(node)),
      );
      const bridge = owner && discriminantBridge(checker, node, owner);
      if (bridge) {
        const list = bridges.get(bridge.symbol) ?? [];
        list.push(bridge);
        bridges.set(bridge.symbol, list);
      }
    }
    ts.forEachChild(node, anchor);
  }
  for (const file of files) anchor(file);
  for (const [symbol, list] of bridges) {
    bridges.set(
      symbol,
      list.filter((bridge) => stableBridge(checker, bridge)),
    );
  }
  function consumer(node) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return;
    // Direct calls carry the same checker-owned output as call-initialized
    // bindings accepted by trustedSource; no lookalike return shape qualifies.
    if (ts.isCallExpression(node)) {
      const owner = owners.get(
        nonNullable(checker, checker.getTypeAtLocation(node)),
      );
      const contextual = checker.getContextualType(node);
      if (owner && contextual) {
        collectLocalCopies(checker, contextual, owner, node, findings);
      }
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const path = valuePath(checker, node);
      const contextual = checker.getContextualType(node);
      if (path && contextual) {
        const actual = nonNullable(checker, checker.getTypeAtLocation(node));
        const owner = trustedSource(checker, node) && owners.get(actual);
        if (owner) {
          collectLocalCopies(checker, contextual, owner, node, findings);
        }
        const inputOwner = contextualOwner(checker, owners, contextual);
        if (inputOwner) {
          collectLocalCopies(checker, actual, inputOwner, node, findings);
        }
        for (const bridge of bridges.get(path.symbol) ?? []) {
          if (samePath(path, bridge)) {
            collectLocalCopies(
              checker,
              contextual,
              bridge.owner,
              node,
              findings,
              bridge.field,
            );
          }
        }
      }
    }
    ts.forEachChild(node, consumer);
  }
  for (const file of files) consumer(file);
  programCache.push({ candidates: accepted, findings });
  return findings;
}
