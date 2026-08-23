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
    matcher,
    subject: expectCall.arguments[0] ?? null,
    expected: node.arguments[0] ?? null,
  };
}

function propertyKey(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return null;
}

function literalShape(node) {
  if (node.type === "Literal") {
    return { kind: "literal", value: node.value };
  }
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return { kind: "literal", value: node.quasis[0].value.cooked };
  }
  return null;
}

function resolveObjectShape(node, callback, sourceCode, depth, seen) {
  const properties = [];
  for (const property of node.properties) {
    if (property.type !== "Property" || property.kind !== "init") return null;
    const key = propertyKey(property);
    const value = resolveStaticShape(
      property.value,
      callback,
      sourceCode,
      depth + 1,
      new Set(seen),
    );
    if (key === null || !value) return null;
    properties.push([key, value.shape]);
  }
  properties.sort(([left], [right]) => left.localeCompare(right));
  return { shape: { kind: "object", properties }, partial: false };
}

function resolveArrayShape(node, callback, sourceCode, depth, seen) {
  const items = [];
  for (const element of node.elements) {
    if (!element || element.type === "SpreadElement") return null;
    const item = resolveStaticShape(
      element,
      callback,
      sourceCode,
      depth + 1,
      new Set(seen),
    );
    if (!item) return null;
    items.push(item.shape);
  }
  return { shape: { kind: "array", items }, partial: false };
}

function isShapeFactoryCall(node) {
  if (node.type !== "CallExpression") return false;
  if (node.callee.type !== "MemberExpression") return false;
  const owner = unwrapExpression(node.callee.object);
  return (
    shapeFactories.has(staticPropertyName(node.callee)) &&
    owner?.type === "Identifier" &&
    owner.name === "expect"
  );
}

function resolveStaticShape(
  expression,
  callback,
  sourceCode,
  depth = 0,
  seen = new Set(),
) {
  if (depth > resolutionDepthLimit) return null;
  const node = unwrapExpression(expression);
  if (!node || seen.has(node)) return null;
  seen.add(node);

  const literal = literalShape(node);
  if (literal) return { shape: literal, partial: false };

  if (node.type === "ObjectExpression") {
    return resolveObjectShape(node, callback, sourceCode, depth, seen);
  }

  if (node.type === "ArrayExpression") {
    return resolveArrayShape(node, callback, sourceCode, depth, seen);
  }

  if (isShapeFactoryCall(node)) {
    const nested = node.arguments[0]
      ? resolveStaticShape(
          node.arguments[0],
          callback,
          sourceCode,
          depth + 1,
          seen,
        )
      : null;
    return nested ? { ...nested, partial: true } : null;
  }

  if (node.type !== "Identifier") return null;
  const initializer = localConstInitializer(node, callback, sourceCode);
  return initializer
    ? resolveStaticShape(initializer, callback, sourceCode, depth + 1, seen)
    : null;
}

function shapesEqual(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "literal") return Object.is(left.value, right.value);
  if (left.kind === "array") {
    return (
      left.items.length === right.items.length &&
      left.items.every((item, index) => shapesEqual(item, right.items[index]))
    );
  }
  return (
    left.properties.length === right.properties.length &&
    left.properties.every(
      ([key, value], index) =>
        key === right.properties[index][0] &&
        shapesEqual(value, right.properties[index][1]),
    )
  );
}

function shapeIsSubset(expected, arranged) {
  if (expected.kind !== arranged.kind) return false;
  if (expected.kind === "literal") {
    return Object.is(expected.value, arranged.value);
  }
  if (expected.kind === "array") {
    return (
      expected.items.length <= arranged.items.length &&
      expected.items.every((item, index) =>
        shapeIsSubset(item, arranged.items[index]),
      )
    );
  }
  const arrangedProperties = new Map(arranged.properties);
  return expected.properties.every(([key, value]) => {
    const arrangedValue = arrangedProperties.get(key);
    return arrangedValue ? shapeIsSubset(value, arrangedValue) : false;
  });
}

function collectShapes(shape, collected = []) {
  collected.push(shape);
  if (shape.kind === "array") {
    for (const item of shape.items) collectShapes(item, collected);
  }
  if (shape.kind === "object") {
    for (const [, value] of shape.properties) collectShapes(value, collected);
  }
  return collected;
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

function directReturnExpression(node) {
  if (!isFunction(node)) return null;
  if (node.body.type !== "BlockStatement") return node.body;
  const returns = node.body.body.filter(
    (statement) => statement.type === "ReturnStatement" && statement.argument,
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
  if (!mockArrangementMethods.has(method)) return null;
  const arranged = node.arguments[0] ?? null;
  return method.startsWith("mockImplementation")
    ? directReturnExpression(arranged)
    : arranged;
}

function assertionMatchesMockedShape(
  assertion,
  mockedShapes,
  callback,
  sourceCode,
) {
  const expected = resolveStaticShape(
    assertion.expected,
    callback,
    sourceCode,
  );
  if (!expected) return false;
  const allowsSubset = assertion.matcher === "toMatchObject" || expected.partial;
  return mockedShapes.some((arranged) =>
    collectShapes(arranged).some((candidate) =>
      allowsSubset
        ? shapeIsSubset(expected.shape, candidate)
        : shapesEqual(expected.shape, candidate),
    ),
  );
}

function analyzeTestBlock(callback, context, sourceCode) {
  const mockedShapes = [];
  const assertions = [];
  walkSameCallback(callback, (node) => {
    const arranged = mockArrangementExpression(node);
    if (arranged) {
      const resolved = resolveStaticShape(arranged, callback, sourceCode);
      if (resolved) mockedShapes.push(resolved.shape);
    }
    const assertion = parseShapeAssertion(node);
    if (assertion) assertions.push(assertion);
  });
  if (mockedShapes.length === 0) return;
  for (const assertion of assertions) {
    if (
      assertionMatchesMockedShape(
        assertion,
        mockedShapes,
        callback,
        sourceCode,
      ) &&
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
