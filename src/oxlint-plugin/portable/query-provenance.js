import { contributesToOutput } from "./expression-output.js";
import {
  findVariable,
  staticPropertyKey,
  staticPropertyName,
  unwrapExpression,
  calleeName,
} from "../shared/scope.js";

export const lifecycleKeys = new Set([
  "isLoading",
  "isPending",
  "isError",
  "isSuccess",
  "isFetching",
  "isValidating",
  "status",
  "fetchStatus",
  "refetch",
  "loadMore",
  "error",
]);

function referenceOrigin(identifier, origin, includeLifecycle) {
  let current = identifier;
  let selected = origin;
  while (
    current.parent?.type === "MemberExpression" &&
    current.parent.object === current
  ) {
    const key = staticPropertyName(current.parent);
    if (!includeLifecycle && lifecycleKeys.has(key)) return null;
    if (selected.properties && key) {
      selected = selected.properties.get(key);
    }
    if (!selected) return null;
    current = current.parent;
  }
  return selected;
}

function dependencyOnly(identifier, boundary) {
  for (
    let current = identifier;
    current && current !== boundary;
    current = current.parent
  ) {
    const parent = current.parent;
    if (
      parent?.type === "CallExpression" &&
      calleeName(parent) === "useMemo" &&
      parent.arguments[1] === current
    ) {
      return true;
    }
  }
  return false;
}

function effectReceiver(identifier, sourceCode) {
  let current = identifier;
  let lookup = false;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === "MemberExpression" && parent.object === current) {
      if (parent.computed && !staticPropertyName(parent)) {
        if (!contributesToOutput(parent, sourceCode)) return true;
        lookup = true;
      }
      current = parent;
    } else if (parent.type === "CallExpression" && parent.callee === current) {
      if (staticPropertyName(current) !== "get") return lookup;
      if (!contributesToOutput(parent, sourceCode)) return true;
      lookup = true;
      current = parent;
    } else if (parent.type === "ChainExpression") current = parent;
    else return false;
  }
  return false;
}

export function queriesInRange(node, state, includeLifecycle = false) {
  const queries = new Set();
  const mapSites = new Set();
  const contributors = new Set();
  if (!node) return { queries, mapSites, contributors };
  const [start, end] = node.range;
  for (const [binding, origin] of state.provenance) {
    for (const reference of binding.references) {
      const identifier = reference.identifier;
      if (
        !reference.isRead() ||
        identifier.range[0] < start ||
        identifier.range[1] > end ||
        dependencyOnly(identifier, node)
      ) {
        continue;
      }
      if (!includeLifecycle && effectReceiver(identifier, state.sourceCode))
        continue;
      const selected = referenceOrigin(identifier, origin, includeLifecycle);
      if (!selected || selected.queries.size === 0) continue;
      contributors.add(selected);
      for (const query of selected.queries) queries.add(query);
      for (const site of selected.mapSites) mapSites.add(site);
    }
  }
  return { queries, mapSites, contributors };
}

export function hasNewJoin(summary) {
  if (summary.queries.size < 2) return false;
  return [...summary.contributors].some(
    (origin) =>
      !origin.alreadyReportedJoin ||
      origin.queries.size !== summary.queries.size
  );
}

function expressionOrigin(expression, state) {
  const summary = queriesInRange(expression, state);
  return {
    queries: summary.queries,
    mapSites: summary.mapSites,
    alreadyReportedJoin: summary.queries.size > 1 && !hasNewJoin(summary),
    properties: propertyOrigins(expression, state),
  };
}

function propertyOrigins(expression, state) {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier" || node?.type === "MemberExpression") {
    const summary = queriesInRange(node, state);
    return summary.contributors.size === 1
      ? [...summary.contributors][0].properties
      : null;
  }
  if (node?.type !== "ObjectExpression") return null;
  const properties = new Map();
  for (const property of node.properties) {
    const key = staticPropertyKey(property);
    if (key) properties.set(key, expressionOrigin(property.value, state));
  }
  return properties;
}

function bindPattern(pattern, origin, state) {
  if (pattern.type === "Identifier") {
    const binding = findVariable(state.sourceCode, pattern);
    if (binding) state.provenance.set(binding, origin);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    bindPattern(pattern.left, origin, state);
    return;
  }
  if (pattern.type !== "ObjectPattern") return;
  for (const property of pattern.properties) {
    const key = staticPropertyKey(property);
    if (!key || lifecycleKeys.has(key)) continue;
    const selected = origin.properties ? origin.properties.get(key) : origin;
    if (selected) bindPattern(property.value, selected, state);
  }
}

export function bindQueryOrigin(declarator, origin, state) {
  const properties = propertyOrigins(declarator.init, state);
  bindPattern(declarator.id, { ...origin, properties }, state);
}
