import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";
import {
  contextFilename,
  isTestFilename,
  staticPropertyName,
  unwrapExpression,
} from "../shared/test-files.js";

const mockArrangementMethods = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
]);
const shapeMatchers = new Set(["toEqual", "toMatchObject", "toStrictEqual"]);
const shapeFactories = new Set(["arrayContaining", "objectContaining"]);
const testBlockNames = new Set([
  "fit",
  "it",
  "specify",
  "test",
  "xit",
  "xtest",
]);
const resolutionDepthLimit = 8;

function isFunction(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

function isTestBlockCallee(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") return testBlockNames.has(callee.name);
  if (callee.type === "MemberExpression") {
    return isTestBlockCallee(callee.object);
  }
  if (callee.type === "CallExpression") {
    return isTestBlockCallee(callee.callee);
  }
  return false;
}

function testBlockCallback(node) {
  if (node?.type !== "CallExpression" || !isTestBlockCallee(node.callee)) {
    return null;
  }
  return (
    node.arguments.find(
      (argument) =>
        argument.type === "ArrowFunctionExpression" ||
        argument.type === "FunctionExpression",
    ) ?? null
  );
}

function isNodeLike(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.type === "string"
  );
}

function pushSameCallbackChildren(node, stack) {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!isNodeLike(child) || isFunction(child)) continue;
      stack.push(child);
    }
  }
}

function walkSameCallback(callback, visit) {
  const stack = [callback.body];
  while (stack.length > 0) {
    const node = stack.pop();
    visit(node);
    pushSameCallbackChildren(node, stack);
  }
}

function nearestFunction(node) {
  let current = node?.parent;
  while (current) {
    if (isFunction(current)) return current;
    current = current.parent;
  }
  return null;
}

function localConstInitializer(identifier, callback, sourceCode) {
  if (identifier?.type !== "Identifier") return null;
  const variable = findVariable(sourceCode, identifier);
  const definition = variable?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const" ||
    nearestFunction(definition.node) !== callback
  ) {
    return null;
  }
  return definition.node.init ?? null;
}

function expectRootCall(expression) {
  if (expression?.type !== "CallExpression") return null;
  const callee = expression.callee;
  if (callee.type === "Identifier" && callee.name === "expect") {
    return expression;
  }
  const owner =
    callee.type === "MemberExpression" ? unwrapExpression(callee.object) : null;
  if (owner?.type === "Identifier" && owner.name === "expect") {
    return expression;
  }
  return null;
}

function parseShapeAssertion(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const matcher = staticPropertyName(node.callee);
  if (!shapeMatchers.has(matcher)) return null;
  let current = unwrapExpression(node.callee.object);
  while (current?.type === "MemberExpression") {
    current = unwrapExpression(current.object);
  }
  const expectCall = expectRootCall(current);
  if (!expectCall) return null;
  return {
    node,
    subject: expectCall.arguments[0] ?? null,
    expected: node.arguments[0] ?? null,
  };
}

function resolvesToShape(
  expression,
  callback,
  sourceCode,
  depth = 0,
  seen = new Set(),
) {
  if (depth > resolutionDepthLimit) return false;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "ObjectExpression" || node.type === "ArrayExpression") {
    return true;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    shapeFactories.has(staticPropertyName(node.callee)) &&
    unwrapExpression(node.callee.object)?.type === "Identifier" &&
    unwrapExpression(node.callee.object).name === "expect"
  ) {
    return node.arguments[0]
      ? resolvesToShape(
          node.arguments[0],
          callback,
          sourceCode,
          depth + 1,
          seen,
        )
      : false;
  }
  if (node.type !== "Identifier") return false;
  const initializer = localConstInitializer(node, callback, sourceCode);
  return initializer
    ? resolvesToShape(initializer, callback, sourceCode, depth + 1, seen)
    : false;
}

function derivesFromResponseJson(
  expression,
  callback,
  sourceCode,
  depth = 0,
  seen = new Set(),
) {
  if (depth > resolutionDepthLimit) return false;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    staticPropertyName(node.callee) === "json"
  ) {
    return true;
  }
  if (node.type === "Identifier") {
    const initializer = localConstInitializer(node, callback, sourceCode);
    return initializer
      ? derivesFromResponseJson(
          initializer,
          callback,
          sourceCode,
          depth + 1,
          seen,
        )
      : false;
  }
  if (node.type === "MemberExpression") {
    return derivesFromResponseJson(
      node.object,
      callback,
      sourceCode,
      depth + 1,
      seen,
    );
  }
  return false;
}

function isMockArrangement(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    mockArrangementMethods.has(staticPropertyName(node.callee))
  );
}

function analyzeTestBlock(callback, context, sourceCode) {
  let hasMockArrangement = false;
  const assertions = [];
  walkSameCallback(callback, (node) => {
    if (isMockArrangement(node)) hasMockArrangement = true;
    const assertion = parseShapeAssertion(node);
    if (assertion) assertions.push(assertion);
  });
  if (!hasMockArrangement) return;
  for (const assertion of assertions) {
    if (
      resolvesToShape(assertion.expected, callback, sourceCode) &&
      derivesFromResponseJson(assertion.subject, callback, sourceCode)
    ) {
      context.report({
        node: assertion.node,
        messageId: "mockedResponseBodyOracle",
      });
    }
  }
}

export default function ruleNoMockedResponseBodyOracle() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow exact response-body shape assertions supplied by a mock in the same test",
      },
      schema: [],
      messages: {
        mockedResponseBodyOracle:
          "This test asserts a response-body object shape supplied by a mock. Object-shape checks are candidates for deleting the entire test block, not for swapping schema.parse with direct equality. Keep the test only if it proves an independently owned effect. Tip: checking response-body or payload shapes is often a sign of a low-value test; assert behavior not supplied by the mock or remove the test.",
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        CallExpression(node) {
          const callback = testBlockCallback(node);
          if (callback) analyzeTestBlock(callback, context, sourceCode);
        },
      };
    },
  };
}
