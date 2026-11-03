import {
  findVariable,
  isFunctionLike,
  unwrapExpression,
} from "../shared/scope.js";

const OUTER_METHODS = new Set(["map", "flatMap", "filter"]);
const INNER_METHODS = new Set(["find", "filter"]);
const LOOP_TYPES = new Set([
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

function isIterationCall(node, methods) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    methods.has(node.callee.property?.name) &&
    isFunctionLike(unwrapExpression(node.arguments[0]))
  );
}

function isInside(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
    if (isFunctionLike(current)) return false;
  }
  return false;
}

function isLoopBinding(identifier, loop, sourceCode) {
  const binding = findVariable(sourceCode, identifier);
  if (!binding) return false;
  if (binding.defs.some((definition) => isInside(definition.node, loop))) {
    return true;
  }
  if (
    loop.type === "ForOfStatement" &&
    loop.left.type === "Identifier" &&
    findVariable(sourceCode, loop.left) === binding
  ) {
    return true;
  }
  return binding.references.some(
    (reference) =>
      isInside(reference.identifier, loop.test) ||
      (reference.isWrite() && isInside(reference.identifier, loop))
  );
}

function iterationOwns(identifier, call, sourceCode) {
  for (let current = call.parent; current; current = current.parent) {
    if (isFunctionLike(current)) {
      const outerCall = current.parent;
      const parameter = current.params[0];
      return (
        isIterationCall(outerCall, OUTER_METHODS) &&
        outerCall.arguments[0] === current &&
        parameter?.type === "Identifier" &&
        findVariable(sourceCode, parameter) ===
          findVariable(sourceCode, identifier)
      );
    }
    if (
      LOOP_TYPES.has(current.type) &&
      isInside(call, current.body) &&
      isLoopBinding(identifier, current, sourceCode)
    ) {
      return true;
    }
  }
  return false;
}

function propertyOwner(expression) {
  const member = unwrapExpression(expression);
  if (member?.type !== "MemberExpression" || member.computed) return null;
  const owner = unwrapExpression(member.object);
  return owner?.type === "Identifier" ? owner : null;
}

function isForeignKeyComparison(node, call, sourceCode) {
  if (node.type !== "BinaryExpression" || node.operator !== "===") return false;
  const left = propertyOwner(node.left);
  const right = propertyOwner(node.right);
  if (!left || !right) return false;
  const parameter = unwrapExpression(call.arguments[0]).params[0];
  const innerBinding = findVariable(sourceCode, parameter);
  if (!innerBinding) return false;
  const leftInner = findVariable(sourceCode, left) === innerBinding;
  const rightInner = findVariable(sourceCode, right) === innerBinding;
  return (
    leftInner !== rightInner &&
    iterationOwns(leftInner ? right : left, call, sourceCode)
  );
}

function containsForeignKeyComparison(node, call, sourceCode) {
  if (!node || isFunctionLike(node)) return false;
  if (isForeignKeyComparison(node, call, sourceCode)) return true;
  return (sourceCode.visitorKeys[node.type] ?? []).some((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.some((child) =>
      containsForeignKeyComparison(child, call, sourceCode)
    );
  });
}

export function hasIterationEquijoin(node, sourceCode) {
  if (!isIterationCall(node, INNER_METHODS)) return false;
  const callback = unwrapExpression(node.arguments[0]);
  return (
    callback.params[0]?.type === "Identifier" &&
    containsForeignKeyComparison(callback.body, node, sourceCode)
  );
}
