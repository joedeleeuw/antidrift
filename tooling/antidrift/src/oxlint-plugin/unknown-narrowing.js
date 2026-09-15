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
      state.cache,
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
      write.range[0] >= node.range[0] && write.range[0] < identifier.range[0],
  );
}

function survivingGuard(statement, state) {
  if (statement.type === "ExpressionStatement") {
    return Boolean(
      predicateCall(
        statement.expression,
        state.variable,
        state.context,
        state.cache,
      )?.asserts,
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
            unchangedSince(statement, identifier, state),
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
          write.range[0] >= parent.range[0] && write.range[0] < parent.range[1],
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
