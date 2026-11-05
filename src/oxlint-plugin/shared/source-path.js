import {
  constInitializer,
  findVariable,
  staticPropertyKey,
  staticPropertyName,
  unwrapExpression,
} from "./scope.js";

export function sourcePath(expression, sourceCode, seen = new Set()) {
  const node = unwrapExpression(expression);
  if (node?.type === "MemberExpression") {
    const key = staticPropertyName(node);
    const owner = !key ? null : sourcePath(node.object, sourceCode, seen);
    return owner ? { ...owner, keys: [...owner.keys, key], node } : null;
  }
  if (node?.type !== "Identifier") return null;
  const binding = findVariable(sourceCode, node);
  if (!binding || seen.has(binding)) return null;
  seen.add(binding);
  const definition = binding.defs[0];
  if (
    binding.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  ) {
    return null;
  }
  const initial = constInitializer(sourceCode, node);
  if (initial && definition.node.id.type === "Identifier") {
    const alias = sourcePath(initial, sourceCode, seen);
    if (alias) return { ...alias, node };
  }
  if (initial && definition.node.id.type === "ObjectPattern") {
    const property = definition.node.id.properties.find(
      (candidate) => candidate.value === definition.name
    );
    const key = property && staticPropertyKey(property);
    const owner = key ? sourcePath(initial, sourceCode, seen) : null;
    if (owner) return { ...owner, keys: [...owner.keys, key], node };
  }
  return { binding, keys: [], node };
}

export function sameSourcePath(left, right) {
  return Boolean(
    left &&
    right &&
    left.binding === right.binding &&
    left.keys.length === right.keys.length &&
    left.keys.every((key, index) => key === right.keys[index])
  );
}

export function sourcePathName(origin) {
  return [origin.binding.name, ...origin.keys].join(".");
}
