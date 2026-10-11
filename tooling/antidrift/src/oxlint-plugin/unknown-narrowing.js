import { predicateCall } from "./unknown-predicates.js";

function guaranteesType(node, truthy, state) {
  if (node.type === "UnaryExpression" && node.operator === "!") {
    return guaranteesType(node.argument, !truthy, state);
  }
  if (node.type === "CallExpression") {
    const predicate = predicateCall(
      node,
      state.variable,
      state.context,
      state.cache
    );
    return truthy && Boolean(predicate) && !predicate.asserts;
  }
  if (
    node.type !== "LogicalExpression" ||
    !["&&", "||"].includes(node.operator)
  ) {
    return false;
  }
  const left = guaranteesType(node.left, truthy, state);
  const right = guaranteesType(node.right, truthy, state);
  return (node.operator === "&&") === truthy ? left || right : left && right;
}

function exits(node) {
  if (!node) return false;
  if (
    [
      "ReturnStatement",
      "ThrowStatement",
      "BreakStatement",
      "ContinueStatement",
    ].includes(node.type)
  ) {
    return true;
  }
  if (node.type === "BlockStatement") return exits(node.body.at(-1));
  if (node.type === "IfStatement") {
    return exits(node.consequent) && exits(node.alternate);
  }
  return false;
}

function unchangedSince(node, identifier, state) {
  return !state.writes.some(
    (write) =>
      write.range[0] >= node.range[0] && write.range[0] < identifier.range[0]
  );
}

function survivingGuard(statement, state) {
  if (statement.type === "ExpressionStatement") {
    return Boolean(
      predicateCall(
        statement.expression,
        state.variable,
        state.context,
        state.cache
      )?.asserts
    );
  }
  if (statement.type !== "IfStatement") return false;
  if (
    exits(statement.consequent) &&
    guaranteesType(statement.test, false, state)
  ) {
    return true;
  }
  return (
    exits(statement.alternate) && guaranteesType(statement.test, true, state)
  );
}

function branchGuard(parent, child, state) {
  if (["IfStatement", "ConditionalExpression"].includes(parent.type)) {
    if (parent.consequent === child) {
      return guaranteesType(parent.test, true, state);
    }
    if (parent.alternate === child) {
      return guaranteesType(parent.test, false, state);
    }
  }
  if (parent.type === "LogicalExpression" && parent.right === child) {
    if (parent.operator === "&&") {
      return guaranteesType(parent.left, true, state);
    }
    if (parent.operator === "||") {
      return guaranteesType(parent.left, false, state);
    }
  }
  if (
    ["WhileStatement", "ForStatement"].includes(parent.type) &&
    parent.body === child &&
    parent.test
  ) {
    return guaranteesType(parent.test, true, state);
  }
  return false;
}

export function isNarrowedUse(identifier, state) {
  let child = identifier;
  while (child.parent) {
    const parent = child.parent;
    if (
      branchGuard(parent, child, state) &&
      unchangedSince(parent, identifier, state)
    ) {
      return true;
    }
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      const preceding = parent.body.slice(0, parent.body.indexOf(child));
      if (
        preceding.some(
          (statement) =>
            survivingGuard(statement, state) &&
            unchangedSince(statement, identifier, state)
        )
      ) {
        return true;
      }
    }
    if (
      [
        "WhileStatement",
        "DoWhileStatement",
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
      ].includes(parent.type) &&
      state.writes.some(
        (write) =>
          write.range[0] >= parent.range[0] && write.range[0] < parent.range[1]
      )
    ) {
      return false;
    }
    if (
      [
        "FunctionExpression",
        "ArrowFunctionExpression",
        "FunctionDeclaration",
      ].includes(parent.type) &&
      state.writes.length > 0
    ) {
      return false;
    }
    child = parent;
  }
  return false;
}

const equalityOperators = new Set(["===", "!==", "==", "!="]);

function rootedAt(node, name) {
  let current = node;
  while (
    current?.type === "MemberExpression" ||
    current?.type === "ChainExpression"
  ) {
    current =
      current.type === "ChainExpression" ? current.expression : current.object;
  }
  return current?.type === "Identifier" && current.name === name;
}

function mentions(node, name) {
  if (!node || typeof node.type !== "string") return false;
  if (node.type === "Identifier" && node.name === name) return true;
  return Object.entries(node).some(([key, child]) => {
    if (key === "parent") return false;
    if (Array.isArray(child)) {
      return child.some((element) => mentions(element, name));
    }
    return mentions(child, name);
  });
}

function isArrayIsArray(callee) {
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Array" &&
    callee.property.name === "isArray"
  );
}

function isNarrowingComparison(subject, other, name) {
  if (mentions(other, name)) return false;
  if (subject.type === "UnaryExpression" && subject.operator === "typeof") {
    return rootedAt(subject.argument, name);
  }
  return rootedAt(subject, name);
}

// The expression only narrows `name`: typeof, `in`, instanceof,
// Array.isArray, truthiness and null checks joined by && or ||, with property
// comparisons on the narrowed value. A cast (`as`) is not narrowing.
function isNarrowing(node, name) {
  switch (node?.type) {
    case "Identifier":
      return node.name === name;
    case "LogicalExpression":
      return (
        ["&&", "||"].includes(node.operator) &&
        isNarrowing(node.left, name) &&
        isNarrowing(node.right, name)
      );
    case "UnaryExpression":
      return node.operator === "!" && isNarrowing(node.argument, name);
    case "CallExpression":
      return (
        isArrayIsArray(node.callee) &&
        node.arguments.length === 1 &&
        rootedAt(node.arguments[0], name)
      );
    case "BinaryExpression":
      if (node.operator === "in") {
        return rootedAt(node.right, name) && !mentions(node.left, name);
      }
      if (node.operator === "instanceof") {
        return rootedAt(node.left, name) && !mentions(node.right, name);
      }
      return (
        equalityOperators.has(node.operator) &&
        (isNarrowingComparison(node.left, node.right, name) ||
          isNarrowingComparison(node.right, node.left, name))
      );
    default:
      return false;
  }
}

function returnedExpression(owner) {
  const body = owner.body;
  if (body?.type !== "BlockStatement") return body;
  const [statement] = body.body;
  return body.body.length === 1 && statement.type === "ReturnStatement"
    ? statement.argument
    : null;
}

// A narrowing helper decodes its unknown parameter: its single returned
// expression only narrows that parameter. Returning the bare parameter is
// forwarding, not narrowing.
export function returnsOnlyNarrowing(owner, name) {
  const returned = returnedExpression(owner);
  return returned?.type !== "Identifier" && isNarrowing(returned, name);
}
