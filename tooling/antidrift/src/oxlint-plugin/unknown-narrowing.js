import { findVariable } from "../semantic-adapters/async-control-flow.mjs";
import { predicateCall } from "./unknown-predicates.js";

function isTrackedVariable(node, state) {
  return (
    node?.type === "Identifier" &&
    findVariable(state.context.sourceCode, node) === state.variable
  );
}

// A structural guard narrows the variable when it evaluates to the returned
// truth value: `typeof x === "t"` and `x instanceof T`, `"k" in x` and
// `Array.isArray(x)` when true; `typeof x !== "t"` when false. Null checks
// alone narrow to no owned shape and are neutral.
function structuralNarrowing(node, state) {
  if (
    node.type === "CallExpression" &&
    isArrayIsArray(node.callee) &&
    node.arguments.length === 1 &&
    isTrackedVariable(node.arguments[0], state)
  ) {
    return true;
  }
  if (node.type !== "BinaryExpression") return null;
  if (node.operator === "instanceof") {
    return isTrackedVariable(node.left, state) ? true : null;
  }
  if (node.operator === "in") {
    return isTrackedVariable(node.right, state) ? true : null;
  }
  if (!equalityOperators.has(node.operator)) return null;
  const typeofOperand = [node.left, node.right].find(
    (side) => side.type === "UnaryExpression" && side.operator === "typeof"
  );
  if (!isTrackedVariable(typeofOperand?.argument, state)) return null;
  return node.operator === "===" || node.operator === "==";
}

function guaranteesType(node, truthy, state) {
  if (node.type === "UnaryExpression" && node.operator === "!") {
    return guaranteesType(node.argument, !truthy, state);
  }
  const narrowsWhen = structuralNarrowing(node, state);
  if (narrowsWhen !== null) return narrowsWhen === truthy;
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

const testOwners = new Set([
  "IfStatement",
  "ConditionalExpression",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
]);

// The node is a truthiness test: the test of a branch or loop, possibly
// through `!` and `&&`/`||` chains.
function isTruthinessTest(node) {
  let child = node;
  let parent = node.parent;
  while (
    parent?.type === "LogicalExpression" ||
    (parent?.type === "UnaryExpression" && parent.operator === "!")
  ) {
    child = parent;
    parent = parent.parent;
  }
  return testOwners.has(parent?.type) && parent.test === child;
}

function isPredicateFunction(node) {
  return (
    (node?.type === "FunctionDeclaration" ||
      node?.type === "FunctionExpression" ||
      node?.type === "ArrowFunctionExpression") &&
    node.returnType?.typeAnnotation?.type === "TSTypePredicate"
  );
}

// The guard expression participates in control flow: the test of a branch,
// loop, conditional or switch, the short-circuiting left operand of `&&`,
// `||` or `??`, or the returned expression of a type predicate. Guards may
// compose through `!`, equality comparisons and logical chains on the way.
function isControlFlowGuard(guard) {
  let child = guard;
  let parent = guard.parent;
  for (;;) {
    if (parent?.type === "LogicalExpression") {
      if (parent.left === child) return true;
    } else if (
      !(parent?.type === "UnaryExpression" && parent.operator === "!") &&
      !(
        parent?.type === "BinaryExpression" &&
        equalityOperators.has(parent.operator)
      )
    ) {
      break;
    }
    child = parent;
    parent = parent.parent;
  }
  if (testOwners.has(parent?.type)) return parent.test === child;
  if (parent?.type === "SwitchStatement") return parent.discriminant === child;
  if (parent?.type === "SwitchCase") return parent.test === child;
  if (parent?.type === "ReturnStatement") {
    let owner = parent.parent;
    while (owner && !owner.type.includes("Function")) owner = owner.parent;
    return isPredicateFunction(owner);
  }
  return isPredicateFunction(parent) && parent.body === child;
}

// The read is a guard operand that inspects the value without using it as a
// typed thing: the operand of `typeof` or `!`, the left of `instanceof`, the
// right of `in`, a side of an equality comparison, or a truthiness test. The
// guard only counts when it steers control flow; `return typeof x` or
// `{ missing: !x }` hands the undecoded value to application logic.
function isBinaryGuardOperand(parent, identifier) {
  if (parent.operator === "instanceof") return parent.left === identifier;
  if (parent.operator === "in") return parent.right === identifier;
  return equalityOperators.has(parent.operator);
}

export function isGuardOperand(identifier) {
  const parent = identifier.parent;
  if (parent.type === "UnaryExpression") {
    return (
      (parent.operator === "typeof" || parent.operator === "!") &&
      isControlFlowGuard(parent)
    );
  }
  if (parent.type === "BinaryExpression") {
    return (
      isBinaryGuardOperand(parent, identifier) && isControlFlowGuard(parent)
    );
  }
  return isTruthinessTest(identifier);
}
