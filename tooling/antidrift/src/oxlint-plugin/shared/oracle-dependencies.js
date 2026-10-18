import { findVariable } from "../../semantic-adapters/kernel/async-control-flow.ts";
import { unwrapExpression, staticPropertyName } from "./test-files.js";

const mutatingMethods = new Set([
  "push",
  "unshift",
  "splice",
  "fill",
  "set",
  "add",
]);

function expressionDependencies(expression, sourceCode) {
  const pending = [expression];
  const dependencies = new Set();
  const visited = new Set();

  function visitMutation(identifier) {
    let target = identifier;
    while (
      target.parent?.type === "MemberExpression" &&
      target.parent.object === target
    ) {
      target = target.parent;
    }
    const parent = target.parent;
    if (parent?.type === "AssignmentExpression" && parent.left === target) {
      pending.push(parent.right);
    }
    if (
      parent?.type === "CallExpression" &&
      parent.callee === target &&
      mutatingMethods.has(staticPropertyName(target))
    ) {
      for (const argument of parent.arguments) pending.push(argument);
    }
    if (
      parent?.type === "CallExpression" &&
      parent.arguments[0] === identifier &&
      parent.callee.type === "MemberExpression" &&
      parent.callee.object.type === "Identifier" &&
      parent.callee.object.name === "Object" &&
      staticPropertyName(parent.callee) === "assign"
    ) {
      for (const argument of parent.arguments.slice(1)) pending.push(argument);
    }
  }

  function visitBinding(identifier) {
    const binding = findVariable(sourceCode, identifier);
    if (!binding || dependencies.has(binding)) return;
    dependencies.add(binding);
    for (const definition of binding.defs) {
      if (definition.type === "Variable") {
        pending.push(definition.node.init);
        const loop = definition.parent?.parent;
        if (loop?.type === "ForOfStatement") pending.push(loop.right);
      }
      if (definition.type === "FunctionName") {
        pending.push(definition.node.body);
      }
    }
    for (const reference of binding.references) {
      if (reference.isWrite()) pending.push(reference.writeExpr);
      visitMutation(reference.identifier);
    }
  }

  function visitCall(call) {
    for (const argument of call.arguments) pending.push(argument);
    const callee = unwrapExpression(call.callee);
    if (callee.type === "MemberExpression") {
      pending.push(callee.object);
      if (callee.computed) pending.push(callee.property);
    }
    if (callee.type !== "Identifier") return;
    const definition = findVariable(sourceCode, callee)?.defs[0];
    const callable = unwrapExpression(
      definition?.node.init ?? definition?.node
    );
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(callable?.type)
    ) {
      pending.push(callable.body);
    }
  }

  while (pending.length > 0) {
    const node = unwrapExpression(pending.pop());
    if (!node || visited.has(node)) continue;
    visited.add(node);
    dependencies.add(node);
    switch (node.type) {
      case "Identifier":
        visitBinding(node);
        break;
      case "MemberExpression":
        pending.push(node.object);
        if (node.computed) pending.push(node.property);
        break;
      case "Property":
        pending.push(node.value);
        if (node.computed) pending.push(node.key);
        break;
      case "CallExpression":
      case "NewExpression":
        visitCall(node);
        break;
      default:
        for (const key of sourceCode.visitorKeys[node.type] ?? []) {
          const children = Array.isArray(node[key]) ? node[key] : [node[key]];
          for (const child of children) pending.push(child);
        }
    }
  }

  return dependencies;
}

function objectLiteralIdentity(node, sourceCode, ancestors) {
  const properties = new Map();
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.method ||
      property.kind !== "init"
    ) {
      return null;
    }
    let name;
    if (!property.computed && property.key.type === "Identifier") {
      name = property.key.name;
    } else if (property.key.type === "Literal") {
      name = String(property.key.value);
    } else {
      return null;
    }
    const identity = literalIdentity(property.value, sourceCode, ancestors);
    if (identity === null) return null;
    properties.set(name, identity);
  }
  return JSON.stringify([
    "object",
    [...properties].sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function literalIdentity(expression, sourceCode, ancestors = new Set()) {
  const node = unwrapExpression(expression);
  if (!node || ancestors.has(node)) return null;
  const visited = new Set(ancestors).add(node);
  if (node.type === "Identifier") {
    const definition = findVariable(sourceCode, node)?.defs[0];
    return definition?.type === "Variable" && definition.parent.kind === "const"
      ? literalIdentity(definition.node.init, sourceCode, visited)
      : null;
  }
  if (node.type === "Literal") {
    if (node.regex) return null;
    return JSON.stringify([typeof node.value, String(node.value)]);
  }
  if (
    node.type === "UnaryExpression" &&
    ["-", "+"].includes(node.operator) &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number"
  ) {
    const number =
      node.operator === "-" ? -node.argument.value : node.argument.value;
    return JSON.stringify([
      "number",
      Object.is(number, -0) ? "-0" : String(number),
    ]);
  }
  if (node.type === "ArrayExpression") {
    const members = node.elements.map((element) =>
      literalIdentity(element, sourceCode, visited)
    );
    return members.includes(null) ? null : JSON.stringify(["array", members]);
  }
  if (node.type !== "ObjectExpression") return null;
  return objectLiteralIdentity(node, sourceCode, visited);
}

export function hasIndependentExpectation(inputs, expected, sourceCode) {
  const actualDependencies = new Set(
    inputs.flatMap((input) => [...expressionDependencies(input, sourceCode)])
  );
  const literalInputs = new Set();
  for (const input of inputs) {
    const identity = literalIdentity(input, sourceCode);
    if (identity !== null) literalInputs.add(identity);
  }
  for (const dependency of actualDependencies) {
    if (
      dependency.type !== "CallExpression" &&
      dependency.type !== "NewExpression"
    ) {
      continue;
    }
    for (const argument of dependency.arguments) {
      const identity = literalIdentity(argument, sourceCode);
      if (identity !== null) literalInputs.add(identity);
    }
  }
  return expected.every(
    (argument) =>
      !literalInputs.has(literalIdentity(argument, sourceCode)) &&
      [...expressionDependencies(argument, sourceCode)].every(
        (dependency) => !actualDependencies.has(dependency)
      )
  );
}
