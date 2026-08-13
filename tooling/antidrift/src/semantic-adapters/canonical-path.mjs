import { findVariable } from "./async-control-flow.mjs";

// Canonical-path unification: reduce an expression such as
// `contract.getPost.responses[200]` or an alias of it to a ⟨root binding⟩ plus
// a list of static segments, so two syntactically different receivers that name
// the same value compare equal. Scope bindings are the only identity source —
// no type information is consulted, and nothing is ever unified across module
// boundaries by inference: the root binding must be the same binding or the
// paths do not match.

const MAX_ALIAS_DEPTH = 12;

const variableIds = new WeakMap();
let nextVariableId = 0;

function variableId(variable) {
  if (!variableIds.has(variable)) {
    nextVariableId += 1;
    variableIds.set(variable, nextVariableId);
  }
  return variableIds.get(variable);
}
const MAX_RESOLVE_DEPTH = 16;

// Oxlint's ESTree output carries `start`/`end`; ESLint carries `range`.
export function nodeStart(node) {
  return node?.range?.[0] ?? node?.start ?? 0;
}

export function nodeEnd(node) {
  return node?.range?.[1] ?? node?.end ?? 0;
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSInstantiationExpression" ||
    current?.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

export function staticSegmentName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed) {
    return member.property.type === "Identifier" ? member.property.name : null;
  }
  const key = unwrapExpression(member.property);
  if (
    key?.type === "Literal" &&
    (typeof key.value === "string" || typeof key.value === "number")
  ) {
    return String(key.value);
  }
  return null;
}

function staticPropertyKey(property) {
  if (property?.type !== "Property") return null;
  if (!property.computed) {
    if (property.key.type === "Identifier") return property.key.name;
    if (property.key.type === "Literal") return String(property.key.value);
    return null;
  }
  const key = unwrapExpression(property.key);
  if (
    key?.type === "Literal" &&
    (typeof key.value === "string" || typeof key.value === "number")
  ) {
    return String(key.value);
  }
  return null;
}

export function isGlobalBinding(variable) {
  return !variable || (variable.defs?.length ?? 0) === 0;
}

export function isImportBinding(variable) {
  return variable?.defs?.[0]?.type === "ImportBinding";
}

export function importSourceOf(variable) {
  const definition = variable?.defs?.[0];
  if (definition?.type !== "ImportBinding") return null;
  const source = definition.parent?.source?.value;
  return typeof source === "string" ? source : null;
}

export function constDeclarator(variable) {
  const definition = variable?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.parent?.kind !== "const" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.node.id?.type !== "Identifier"
  ) {
    return null;
  }
  return definition.node;
}

export function hasNonInitWrite(variable) {
  return (variable?.references ?? []).some(
    (reference) => reference.isWrite?.() && reference.init !== true,
  );
}

// A root the rule is willing to trust: a single-definition const or an import
// binding that is never rebound in this file.
export function isStableRoot(variable) {
  if (isGlobalBinding(variable)) return false;
  if ((variable.defs?.length ?? 0) !== 1) return false;
  if (hasNonInitWrite(variable)) return false;
  return Boolean(isImportBinding(variable) || constDeclarator(variable));
}

function rawPath(sourceCode, expression) {
  const segments = [];
  let current = unwrapExpression(expression);
  while (current?.type === "MemberExpression") {
    if (current.optional === true) return null;
    const segment = staticSegmentName(current);
    if (segment === null) return null;
    segments.unshift(segment);
    current = unwrapExpression(current.object);
  }
  if (current?.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, current);
  if (isGlobalBinding(variable)) return null;
  return { variable, segments, identifier: current };
}

function descendObject(expression, segment) {
  const target = unwrapExpression(expression);
  if (target?.type === "ObjectExpression") {
    const match = target.properties.find(
      (property) => staticPropertyKey(property) === segment,
    );
    return match ? match.value : null;
  }
  if (target?.type === "ArrayExpression" && /^\d+$/u.test(segment)) {
    return target.elements[Number(segment)] ?? null;
  }
  // Contract builders (`c.router({...})`, `os.router({...})`) hold the shape in
  // a literal argument; descending it keeps the contract seam resolvable.
  if (target?.type === "CallExpression") {
    for (let index = target.arguments.length - 1; index >= 0; index -= 1) {
      const argument = unwrapExpression(target.arguments[index]);
      if (argument?.type === "ObjectExpression") {
        return descendObject(argument, segment);
      }
    }
  }
  return null;
}

// One expansion step: a const alias whose initializer is an identifier or member
// expression, or a path that descends an in-file object literal until it lands
// on another binding. Both are local static resolution, not inference — the
// binding is visible in this file or no step is taken.
function expandOnce(sourceCode, path) {
  const declarator = constDeclarator(path.variable);
  if (!declarator || hasNonInitWrite(path.variable)) return null;
  const initializer = unwrapExpression(declarator.init);
  if (
    initializer?.type === "Identifier" ||
    initializer?.type === "MemberExpression"
  ) {
    const next = rawPath(sourceCode, initializer);
    if (!next) return null;
    return {
      variable: next.variable,
      segments: [...next.segments, ...path.segments],
      identifier: next.identifier,
    };
  }
  let expression = initializer;
  for (let index = 0; index < path.segments.length; index += 1) {
    const descended = descendObject(expression, path.segments[index]);
    if (!descended) return null;
    expression = unwrapExpression(descended);
    if (expression?.type !== "Identifier") continue;
    const variable = findVariable(sourceCode, expression);
    if (isGlobalBinding(variable)) return null;
    return {
      variable,
      segments: path.segments.slice(index + 1),
      identifier: expression,
    };
  }
  return null;
}

export function canonicalPath(sourceCode, expression) {
  let path = rawPath(sourceCode, expression);
  if (!path) return null;
  const seen = new Set();
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    const key = `${variableId(path.variable)}\u0000${path.segments.join("\u0000")}`;
    if (seen.has(key)) return path;
    seen.add(key);
    const next = expandOnce(sourceCode, path);
    if (!next) return path;
    path = next;
  }
  return path;
}

export function samePath(left, right) {
  return Boolean(
    left &&
      right &&
      left.variable === right.variable &&
      left.segments.length === right.segments.length &&
      left.segments.every((segment, index) => segment === right.segments[index]),
  );
}

export function sharesPathPrefix(left, right) {
  if (!left || !right || left.variable !== right.variable) return false;
  const shared = Math.min(left.segments.length, right.segments.length);
  for (let index = 0; index < shared; index += 1) {
    if (left.segments[index] !== right.segments[index]) return false;
  }
  return true;
}

// Best-effort resolution of a canonical path to the expression that produced it.
// Used for origin evidence only — never for identity, so a dead end is harmless.
export function resolvePathValue(sourceCode, path) {
  if (!path) return null;
  let variable = path.variable;
  let segments = path.segments;
  const seen = new Set();
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH; depth += 1) {
    if (seen.has(variable)) return null;
    seen.add(variable);
    const declarator = constDeclarator(variable);
    if (!declarator) return { variable, segments, expression: null };
    let expression = unwrapExpression(declarator.init);
    for (const segment of segments) {
      expression = expression && descendObject(expression, segment);
      if (!expression) return { variable, segments, expression: null };
      expression = unwrapExpression(expression);
    }
    if (expression?.type !== "Identifier") {
      return { variable, segments, expression };
    }
    const next = findVariable(sourceCode, expression);
    if (isGlobalBinding(next)) return { variable, segments, expression: null };
    variable = next;
    segments = [];
  }
  return null;
}

// The identifier a call/member chain is ultimately rooted at, e.g. `z` in
// `z.object({}).strict()` and `Base` in `Base.extend({})`.
export function chainBaseIdentifier(expression) {
  let current = unwrapExpression(expression);
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH; depth += 1) {
    if (current?.type === "MemberExpression") {
      current = unwrapExpression(current.object);
      continue;
    }
    if (current?.type === "CallExpression") {
      current = unwrapExpression(current.callee);
      continue;
    }
    if (current?.type === "NewExpression") {
      current = unwrapExpression(current.callee);
      continue;
    }
    return current?.type === "Identifier" ? current : null;
  }
  return null;
}
