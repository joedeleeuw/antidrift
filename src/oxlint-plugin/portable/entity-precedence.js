import { findDescendant } from "./ast.js";
import { queriesInRange } from "./query-provenance.js";
import {
  sameSourcePath,
  sourcePath,
  sourcePathName,
} from "../shared/source-path.js";
import {
  findVariable,
  isFunctionLike,
  nearestFunction,
  staticPropertyKey,
  staticPropertyName,
  unwrapExpression,
} from "../shared/scope.js";
import {
  firstPartyContract,
  getResolvedType,
  getTypeServices,
  isEntityIdentityKey,
  shareEntityIdentity,
} from "../shared/type-services.js";

function fieldSource(expression, key, sourceCode) {
  const member = unwrapExpression(expression);
  return member?.type === "MemberExpression" &&
    staticPropertyName(member) === key
    ? sourcePath(member.object, sourceCode)
    : null;
}

function coalescedPair(property, sourceCode) {
  const key = staticPropertyKey(property);
  const expression = unwrapExpression(property.value);
  if (
    !key ||
    expression?.type !== "LogicalExpression" ||
    expression.operator !== "??"
  ) {
    return null;
  }
  const left = fieldSource(expression.left, key, sourceCode);
  const right = fieldSource(expression.right, key, sourceCode);
  return left && right && !sameSourcePath(left, right)
    ? { left, right, key }
    : null;
}

function addPair(groups, pair) {
  const existing = groups.find(
    (group) =>
      sameSourcePath(group.left, pair.left) &&
      sameSourcePath(group.right, pair.right)
  );
  if (existing) existing.keys.add(pair.key);
  else {
    groups.push({
      left: pair.left,
      right: pair.right,
      keys: new Set([pair.key]),
    });
  }
}

function precedencePairs(node, sourceCode) {
  const coalesced = [];
  const overrides = [];
  let base = null;
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      base = sourcePath(property.argument, sourceCode);
      overrides.length = 0;
      coalesced.length = 0;
      continue;
    }
    const pair = coalescedPair(property, sourceCode);
    if (pair) addPair(coalesced, pair);
    const key = staticPropertyKey(property);
    const overriding =
      pair && sameSourcePath(pair.right, base)
        ? pair.left
        : fieldSource(property.value, key, sourceCode);
    if (base && overriding && !sameSourcePath(base, overriding)) {
      addPair(overrides, { left: base, right: overriding, key });
    }
  }
  return [
    ...coalesced.filter((group) => group.keys.size >= 2),
    ...overrides.filter((group) => group.keys.size >= 3),
  ];
}

function distinctReactiveOrigins(pair, state) {
  if (!state) return false;
  const left = queriesInRange(pair.left.node, state).queries;
  const right = queriesInRange(pair.right.node, state).queries;
  return (
    left.size > 0 &&
    right.size > 0 &&
    [...left].some((query) => !right.has(query)) &&
    [...right].some((query) => !left.has(query))
  );
}

function identitySource(expression, sourceCode) {
  const member = unwrapExpression(expression);
  const key = staticPropertyName(member);
  return key && isEntityIdentityKey(key)
    ? sourcePath(member.object, sourceCode)
    : null;
}

function comparesIdentities(node, pair, sourceCode) {
  if (
    node.type === "BinaryExpression" &&
    new Set(["===", "==", "!==", "!="]).has(node.operator)
  ) {
    const left = identitySource(node.left, sourceCode);
    const right = identitySource(node.right, sourceCode);
    return (
      (sameSourcePath(left, pair.left) && sameSourcePath(right, pair.right)) ||
      (sameSourcePath(left, pair.right) && sameSourcePath(right, pair.left))
    );
  }
  const key =
    node.type === "CallExpression" && staticPropertyName(node.callee) === "get"
      ? node.arguments[0]
      : null;
  const identity = identitySource(key, sourceCode);
  return (
    sameSourcePath(identity, pair.left) || sameSourcePath(identity, pair.right)
  );
}

function enclosingDeclaratorBinding(node, sourceCode) {
  for (
    let current = node.parent;
    current && !isFunctionLike(current);
    current = current.parent
  ) {
    if (
      current.type === "VariableDeclarator" &&
      current.id?.type === "Identifier"
    ) {
      return findVariable(sourceCode, current.id);
    }
  }
  return null;
}

function exposesRepresentations(returned, node, pair, sourceCode) {
  const expression = unwrapExpression(returned);
  if (
    expression?.type !== "ObjectExpression" &&
    expression?.type !== "ArrayExpression"
  ) {
    return false;
  }
  const binding = enclosingDeclaratorBinding(node, sourceCode);
  const containsMerged = findDescendant(
    expression,
    (candidate) =>
      candidate === node ||
      (binding &&
        candidate.type === "Identifier" &&
        findVariable(sourceCode, candidate) === binding)
  );
  if (!containsMerged) return false;
  const exposed =
    expression.type === "ArrayExpression"
      ? expression.elements
      : expression.properties.map((property) => property.value);
  return [pair.left, pair.right].some((origin) =>
    exposed.some((candidate) =>
      sameSourcePath(sourcePath(candidate, sourceCode), origin)
    )
  );
}

const CONFIG_NAME = /(?:options|config|theme|style|settings|prefs|defaults)$/iu;

function corroboratesEntityContracts(pair, sourceCode) {
  if (
    CONFIG_NAME.test(sourcePathName(pair.left)) ||
    CONFIG_NAME.test(sourcePathName(pair.right))
  ) {
    return false;
  }
  const services = getTypeServices(sourceCode);
  if (!services) return true;
  const contracts = [pair.left, pair.right].map((origin) =>
    firstPartyContract(getResolvedType(origin.node, sourceCode), services)
  );
  if (
    contracts.some((contract) => !contract || CONFIG_NAME.test(contract.name))
  ) {
    return false;
  }
  const [left, right] = contracts;
  return (
    left.symbol !== right.symbol && shareEntityIdentity(left, right, services)
  );
}

function corroboratesEntity(node, pair, sourceCode) {
  if (!corroboratesEntityContracts(pair, sourceCode)) return false;
  const owner = nearestFunction(node);
  if (!owner) return false;
  return Boolean(
    findDescendant(
      owner.body,
      (candidate) =>
        comparesIdentities(candidate, pair, sourceCode) ||
        (candidate.type === "ReturnStatement" &&
          exposesRepresentations(candidate.argument, node, pair, sourceCode)),
      (candidate) => !isFunctionLike(candidate)
    ) || exposesRepresentations(owner.body, node, pair, sourceCode)
  );
}

const ENTITY_WRITE_METHODS = new Set(["patch", "replace", "update", "upsert"]);

function writesSourceEntity(call, pair, sourceCode) {
  if (!ENTITY_WRITE_METHODS.has(staticPropertyName(call.callee))) return false;
  return call.arguments.slice(0, -1).some((argument) => {
    const identity = identitySource(argument, sourceCode);
    return (
      identity &&
      [pair.left, pair.right].some(
        (origin) =>
          origin.binding === identity.binding &&
          identity.keys.every((key, index) => origin.keys[index] === key)
      )
    );
  });
}

function exclusivelyWrittenEntity(node, pair, sourceCode, seen = new Set()) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === "Property" && parent.value === current) {
      current = parent;
    } else if (parent.type === "ObjectExpression") {
      current = parent;
    } else if (
      parent.type === "VariableDeclarator" &&
      parent.init === current &&
      parent.id.type === "Identifier"
    ) {
      const binding = findVariable(sourceCode, parent.id);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      const reads = binding.references.filter((reference) =>
        reference.isRead()
      );
      return (
        reads.length === 1 &&
        exclusivelyWrittenEntity(reads[0].identifier, pair, sourceCode, seen)
      );
    } else {
      return (
        parent.type === "CallExpression" &&
        parent.arguments.at(-1) === current &&
        writesSourceEntity(parent, pair, sourceCode)
      );
    }
  }
  return false;
}

export function checkEntityPrecedence(node, context, state) {
  const pairs = precedencePairs(node, context.sourceCode);
  const pair = pairs.find(
    (candidate) =>
      (distinctReactiveOrigins(candidate, state) ||
        corroboratesEntity(node, candidate, context.sourceCode)) &&
      !exclusivelyWrittenEntity(node, candidate, context.sourceCode)
  );
  if (!pair) return false;
  context.report({
    node,
    message: `Object literal reconciles overlapping fields across multiple entity representations ('${sourcePathName(pair.left)}' and '${sourcePathName(pair.right)}'); normalize into one authoritative projection at the store or selector boundary.`,
  });
  return true;
}
