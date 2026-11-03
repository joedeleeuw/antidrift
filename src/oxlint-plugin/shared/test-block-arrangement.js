import { staticPropertyName } from "./test-files.js";
import {
  isFunctionNode,
  literalContainerTypes,
  nearestFunction,
  resolveStaticShape,
  unwrapExpression,
} from "./test-block-shapes.js";

const booleanValues = new Set([true, false]);
export const equalityMethods = new Set([
  "deepEqual",
  "deepStrictEqual",
  "equal",
  "strictEqual",
]);
export const bareAssertionMethods = new Set(["ok"]);
const booleanMatcherMethods = new Set(["toBe", "toEqual", "toStrictEqual"]);
export const equalityMatcherMethods = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
]);
const mockArrangementMethods = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
]);
const testBlockNames = new Set([
  "fit",
  "it",
  "specify",
  "test",
  "xit",
  "xtest",
]);

function calleeName(callee) {
  if (callee?.type === "Identifier") {
    return callee.name;
  }
  return staticPropertyName(callee);
}

export function isBooleanLiteral(node) {
  return node?.type === "Literal" && booleanValues.has(node.value);
}

function isIncludesCall(node) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "CallExpression" &&
    expression.callee.type === "MemberExpression" &&
    staticPropertyName(expression.callee) === "includes"
  );
}

function isInExpression(node) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "BinaryExpression" && expression.operator === "in"
  );
}

function isKeyOwnershipCall(node) {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== "CallExpression" ||
    expression.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const method = staticPropertyName(expression.callee);
  if (method === "hasOwnProperty") {
    return true;
  }
  const owner = unwrapExpression(expression.callee.object);
  return (
    method === "hasOwn" &&
    owner?.type === "Identifier" &&
    owner.name === "Object"
  );
}

function isSomeMembershipCall(node) {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== "CallExpression" ||
    expression.callee.type !== "MemberExpression" ||
    staticPropertyName(expression.callee) !== "some"
  ) {
    return false;
  }
  const callback = expression.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  if (callback.body.type !== "BlockStatement") {
    return true;
  }
  return callback.body.body.some(
    (statement) =>
      statement.type === "ReturnStatement" && Boolean(statement.argument)
  );
}

function isMembershipPredicate(node) {
  const expression = unwrapExpression(node);
  return (
    isIncludesCall(expression) ||
    isInExpression(expression) ||
    isKeyOwnershipCall(expression) ||
    isSomeMembershipCall(expression)
  );
}

function isNegatedMembershipPredicate(node) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "UnaryExpression" &&
    expression.operator === "!" &&
    isMembershipPredicate(expression.argument)
  );
}

function isBareMembershipAssertion(node) {
  if (node.type !== "CallExpression") {
    return false;
  }
  const name = calleeName(node.callee);
  if (
    equalityMethods.has(name) &&
    isMembershipPredicate(node.arguments[0]) &&
    isBooleanLiteral(node.arguments[1])
  ) {
    return true;
  }
  return (
    (bareAssertionMethods.has(name) || name === "assert") &&
    (isMembershipPredicate(node.arguments[0]) ||
      isNegatedMembershipPredicate(node.arguments[0]))
  );
}

function isMembershipMatcherAssertion(node) {
  const record = parseExpectAssertion(node);
  if (!record) {
    return false;
  }
  if (record.matcher === "toContain") {
    return true;
  }
  if (record.matcher === "toHaveProperty") {
    return record.args.length <= 1;
  }
  return (
    booleanMatcherMethods.has(record.matcher) &&
    isBooleanLiteral(record.args[0]) &&
    isMembershipPredicate(record.subject)
  );
}

export function isMembershipAssertionNode(node) {
  return isBareMembershipAssertion(node) || isMembershipMatcherAssertion(node);
}

function isTestBlockCallee(callee) {
  if (!callee) {
    return false;
  }
  if (callee.type === "Identifier") {
    return testBlockNames.has(callee.name);
  }
  if (callee.type === "MemberExpression") {
    return isTestBlockCallee(callee.object);
  }
  if (callee.type === "CallExpression") {
    return isTestBlockCallee(callee.callee);
  }
  return false;
}

export function testBlockCallback(node) {
  if (node?.type !== "CallExpression" || !isTestBlockCallee(node.callee)) {
    return null;
  }
  return (
    node.arguments.find(
      (argument) =>
        argument.type === "ArrowFunctionExpression" ||
        argument.type === "FunctionExpression"
    ) ?? null
  );
}

export function enclosingTestBlockCallback(node) {
  let current = node.parent;
  while (current) {
    if (
      (current.type === "ArrowFunctionExpression" ||
        current.type === "FunctionExpression") &&
      testBlockCallback(current.parent) === current
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function walkWithinBlock(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === "parent") {
        continue;
      }
      const childCandidate = node[key];
      const children = Array.isArray(childCandidate)
        ? childCandidate
        : [childCandidate];
      for (const child of children) {
        if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string" &&
          !testBlockCallback(child)
        ) {
          stack.push(child);
        }
      }
    }
  }
}

function expectRootCall(expression) {
  if (expression?.type !== "CallExpression") {
    return null;
  }
  const callee = expression.callee;
  if (callee.type === "Identifier" && callee.name === "expect") {
    return expression;
  }
  const owner =
    callee.type === "MemberExpression" ? unwrapExpression(callee.object) : null;
  return owner?.type === "Identifier" && owner.name === "expect"
    ? expression
    : null;
}

export function parseExpectAssertion(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const matcher = staticPropertyName(node.callee);
  if (!matcher) {
    return null;
  }
  const modifiers = new Set();
  let current = unwrapExpression(node.callee.object);
  while (current?.type === "MemberExpression") {
    modifiers.add(staticPropertyName(current));
    current = unwrapExpression(current.object);
  }
  const expectCall = expectRootCall(current);
  if (!expectCall) {
    return null;
  }
  const subject = expectCall.arguments[0]
    ? unwrapExpression(expectCall.arguments[0])
    : null;
  return {
    kind: "expect",
    node,
    expectCall,
    subject,
    matcher,
    args: node.arguments,
    modifiers,
  };
}

export function parseAssertAssertion(node) {
  if (node.type !== "CallExpression") {
    return null;
  }
  if (node.callee.type === "Identifier" && node.callee.name === "assert") {
    return { kind: "assert", node, method: "assert", args: node.arguments };
  }
  const owner =
    node.callee.type === "MemberExpression"
      ? unwrapExpression(node.callee.object)
      : null;
  if (owner?.type === "Identifier" && owner.name === "assert") {
    return {
      kind: "assert",
      node,
      method: staticPropertyName(node.callee),
      args: node.arguments,
    };
  }
  return null;
}

function directReturnExpression(node) {
  if (!isFunctionNode(node)) {
    return null;
  }
  if (node.body.type !== "BlockStatement") {
    return node.body;
  }
  const returns = node.body.body.filter(
    (statement) => statement.type === "ReturnStatement" && statement.argument
  );
  return returns.length === 1 ? returns[0].argument : null;
}

function mockArrangementExpression(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const method = staticPropertyName(node.callee);
  if (!mockArrangementMethods.has(method)) {
    return null;
  }
  const arranged = node.arguments[0] ?? null;
  return method.startsWith("mockImplementation")
    ? directReturnExpression(arranged)
    : arranged;
}

function recordActArguments(calls, assertionCalls) {
  const actArgNames = new Set();
  const actArgLiterals = [];
  for (const call of calls) {
    if (assertionCalls.has(call)) continue;
    for (const argument of call.arguments) {
      const expression = unwrapExpression(argument);
      if (expression?.type === "Identifier") {
        actArgNames.add(expression.name);
      } else if (literalContainerTypes.has(expression?.type)) {
        actArgLiterals.push(expression);
      }
    }
  }
  return { actArgNames, actArgLiterals };
}

export function collectBlockFacts(callback, sourceCode) {
  const calls = [];
  const bindings = new Map();
  const mockedShapes = [];
  walkWithinBlock(callback.body, (node) => {
    if (node.type === "CallExpression") {
      calls.push(node);
      if (nearestFunction(node) === callback) {
        const arranged = mockArrangementExpression(node);
        const resolved =
          arranged && resolveStaticShape(arranged, { callback, sourceCode });
        if (resolved) mockedShapes.push(resolved.shape);
      }
    } else if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init
    ) {
      bindings.set(node.id.name, node.init);
    }
  });
  const assertions = [];
  const assertionCalls = new Set();
  for (const call of calls) {
    const record = parseExpectAssertion(call) ?? parseAssertAssertion(call);
    if (!record) continue;
    assertions.push(record);
    assertionCalls.add(call);
    if (record.expectCall) assertionCalls.add(record.expectCall);
  }
  return {
    callback,
    assertions,
    bindings,
    mockedShapes,
    ...recordActArguments(calls, assertionCalls),
  };
}
