import { findVariable } from "../../semantic-adapters/kernel/variable-lookup.ts";
import { staticPropertyName } from "./test-files.js";

export const booleanValues = new Set([true, false]);
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
const shapeMatcherMethods = new Set([
  "toEqual",
  "toMatchObject",
  "toStrictEqual",
]);
const shapeFactories = new Set(["arrayContaining", "objectContaining"]);
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
export const literalContainerTypes = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
]);
export const resolutionDepthLimit = 8;

function calleeName(callee) {
  if (callee?.type === "Identifier") {
    return callee.name;
  }
  return staticPropertyName(callee);
}

export function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

export function unwrapAwaitedExpression(node) {
  let current = unwrapExpression(node);
  while (current?.type === "AwaitExpression") {
    current = unwrapExpression(current.argument);
  }
  return current;
}

function isFunctionNode(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression" ||
    node?.type === "FunctionDeclaration"
  );
}

export function nearestFunction(node) {
  let current = node?.parent;
  while (current) {
    if (isFunctionNode(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
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

export function constInitializer(sourceCode, identifier, callback = null) {
  if (identifier?.type !== "Identifier") {
    return null;
  }
  const scopeBinding = findVariable(sourceCode, identifier);
  const definition = scopeBinding?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const"
  ) {
    return null;
  }
  if (callback && nearestFunction(definition.node) !== callback) {
    return null;
  }
  return definition.node.init ?? null;
}

export function templateText(template) {
  if (template.expressions.length > 0) {
    return null;
  }
  return template.quasis.map((quasi) => quasi.value.cooked).join("");
}

export function propertyKeyName(property) {
  if (property.type !== "Property") {
    return null;
  }
  if (property.computed) {
    return property.key.type === "Literal" ? String(property.key.value) : null;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  if (property.key.type === "Literal") {
    return String(property.key.value);
  }
  return null;
}

function isShapeFactoryCall(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return false;
  }
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
  seen = new Set()
) {
  if (depth > resolutionDepthLimit) {
    return null;
  }
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (node.type === "Literal") {
    return { shape: { kind: "literal", value: node.value }, partial: false };
  }
  if (node.type === "TemplateLiteral") {
    const cooked = templateText(node);
    return cooked === null
      ? null
      : { shape: { kind: "literal", value: cooked }, partial: false };
  }
  if (node.type === "ObjectExpression") {
    const properties = [];
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init") {
        return null;
      }
      const key = propertyKeyName(property);
      const propertyShape = resolveStaticShape(
        property.value,
        callback,
        sourceCode,
        depth + 1,
        new Set(seen)
      );
      if (key === null || !propertyShape) {
        return null;
      }
      properties.push([key, propertyShape.shape]);
    }
    properties.sort(([left], [right]) => left.localeCompare(right));
    return { shape: { kind: "object", properties }, partial: false };
  }
  if (node.type === "ArrayExpression") {
    const elementShapes = [];
    for (const element of node.elements) {
      if (!element || element.type === "SpreadElement") {
        return null;
      }
      const resolvedElement = resolveStaticShape(
        element,
        callback,
        sourceCode,
        depth + 1,
        new Set(seen)
      );
      if (!resolvedElement) {
        return null;
      }
      elementShapes.push(resolvedElement.shape);
    }
    return { shape: { kind: "array", elementShapes }, partial: false };
  }
  if (isShapeFactoryCall(node)) {
    const nested = node.arguments[0]
      ? resolveStaticShape(
          node.arguments[0],
          callback,
          sourceCode,
          depth + 1,
          seen
        )
      : null;
    return nested ? { ...nested, partial: true } : null;
  }
  if (node.type !== "Identifier") {
    return null;
  }
  const initializer = constInitializer(sourceCode, node, callback);
  return initializer
    ? resolveStaticShape(initializer, callback, sourceCode, depth + 1, seen)
    : null;
}

function shapesEqual(left, right) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "literal") {
    return Object.is(left.value, right.value);
  }
  if (left.kind === "array") {
    return (
      left.elementShapes.length === right.elementShapes.length &&
      left.elementShapes.every((elementShape, index) =>
        shapesEqual(elementShape, right.elementShapes[index])
      )
    );
  }
  return (
    left.properties.length === right.properties.length &&
    left.properties.every(
      ([key, propShape], index) =>
        key === right.properties[index][0] &&
        shapesEqual(propShape, right.properties[index][1])
    )
  );
}

function shapeIsSubset(expected, arranged) {
  if (expected.kind !== arranged.kind) {
    return false;
  }
  if (expected.kind === "literal") {
    return Object.is(expected.value, arranged.value);
  }
  if (expected.kind === "array") {
    return (
      expected.elementShapes.length <= arranged.elementShapes.length &&
      expected.elementShapes.every((elementShape, index) =>
        shapeIsSubset(elementShape, arranged.elementShapes[index])
      )
    );
  }
  const arrangedProperties = new Map(arranged.properties);
  return expected.properties.every(([key, propShape]) => {
    const arrangedPropertyShape = arrangedProperties.get(key);
    return arrangedPropertyShape
      ? shapeIsSubset(propShape, arrangedPropertyShape)
      : false;
  });
}

function collectShapes(shape, collected = []) {
  collected.push(shape);
  if (shape.kind === "array") {
    for (const elementShape of shape.elementShapes) {
      collectShapes(elementShape, collected);
    }
  } else if (shape.kind === "object") {
    for (const [, propShape] of shape.properties) {
      collectShapes(propShape, collected);
    }
  }
  return collected;
}

function derivesFromResponseJson(
  expression,
  callback,
  sourceCode,
  depth = 0,
  seen = new Set()
) {
  if (depth > resolutionDepthLimit) {
    return false;
  }
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    staticPropertyName(node.callee) === "json"
  ) {
    return true;
  }
  if (node.type === "Identifier") {
    const initializer = constInitializer(sourceCode, node, callback);
    return initializer
      ? derivesFromResponseJson(
          initializer,
          callback,
          sourceCode,
          depth + 1,
          seen
        )
      : false;
  }
  if (node.type === "MemberExpression") {
    return derivesFromResponseJson(
      node.object,
      callback,
      sourceCode,
      depth + 1,
      seen
    );
  }
  return false;
}

export function matchesMockedResponseBody(record, facts, sourceCode) {
  if (
    record.kind !== "expect" ||
    !shapeMatcherMethods.has(record.matcher) ||
    facts.mockedShapes.length === 0 ||
    nearestFunction(record.node) !== facts.callback
  ) {
    return false;
  }
  const expected = resolveStaticShape(
    record.args[0],
    facts.callback,
    sourceCode
  );
  if (!expected) {
    return false;
  }
  const allowsSubset = record.matcher === "toMatchObject" || expected.partial;
  const matchesMock = facts.mockedShapes.some((arranged) =>
    collectShapes(arranged).some((candidate) =>
      allowsSubset
        ? shapeIsSubset(expected.shape, candidate)
        : shapesEqual(expected.shape, candidate)
    )
  );
  return (
    matchesMock &&
    derivesFromResponseJson(record.subject, facts.callback, sourceCode)
  );
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
          arranged && resolveStaticShape(arranged, callback, sourceCode);
        if (resolved) {
          mockedShapes.push(resolved.shape);
        }
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
    if (!record) {
      continue;
    }
    assertions.push(record);
    assertionCalls.add(call);
    if (record.expectCall) {
      assertionCalls.add(record.expectCall);
    }
  }
  const actArgNames = new Set();
  const actArgLiterals = [];
  for (const call of calls) {
    if (assertionCalls.has(call)) {
      continue;
    }
    for (const argument of call.arguments) {
      const expression = unwrapExpression(argument);
      if (expression?.type === "Identifier") {
        actArgNames.add(expression.name);
      } else if (literalContainerTypes.has(expression?.type)) {
        actArgLiterals.push(expression);
      }
    }
  }
  return {
    callback,
    assertions,
    bindings,
    actArgNames,
    actArgLiterals,
    mockedShapes,
  };
}

export function resolveLiteralNode(node, sourceCode, depth) {
  const expression = unwrapExpression(node);
  if (!expression || depth <= 0) {
    return null;
  }
  if (expression.type === "Identifier") {
    const init = constInitializer(sourceCode, expression);
    return init ? resolveLiteralNode(init, sourceCode, depth - 1) : null;
  }
  return literalContainerTypes.has(expression.type) ? expression : null;
}

function objectPropertyExpression(
  objectExpression,
  segment,
  sourceCode,
  depth
) {
  let matchedProperty = null;
  for (const property of objectExpression.properties) {
    if (property.type === "SpreadElement") {
      const spread = resolveLiteralNode(
        property.argument,
        sourceCode,
        depth - 1
      );
      if (spread?.type !== "ObjectExpression") {
        continue;
      }
      const inherited = objectPropertyExpression(
        spread,
        segment,
        sourceCode,
        depth - 1
      );
      if (inherited) {
        matchedProperty = inherited;
      }
      continue;
    }
    if (propertyKeyName(property) === String(segment)) {
      matchedProperty = property.value;
    }
  }
  return matchedProperty;
}

export function literalAtPath(baseNode, path, sourceCode) {
  let depth = resolutionDepthLimit;
  let current = resolveLiteralNode(baseNode, sourceCode, depth);
  for (const segment of path) {
    if (!current || depth <= 0) {
      return null;
    }
    depth -= 1;
    let next = null;
    if (current.type === "ObjectExpression") {
      next = objectPropertyExpression(current, segment, sourceCode, depth);
    } else if (
      current.type === "ArrayExpression" &&
      typeof segment === "number" &&
      !current.elements.some((element) => element?.type === "SpreadElement")
    ) {
      next = current.elements[segment] ?? null;
    }
    current = next
      ? (resolveLiteralNode(next, sourceCode, depth) ?? unwrapExpression(next))
      : null;
  }
  return current;
}

function hasSpreadProperty(objectExpression) {
  return objectExpression.properties.some(
    (property) => property.type === "SpreadElement"
  );
}

export function literalNodesEqual(
  leftNode,
  rightNode,
  depth = resolutionDepthLimit
) {
  const left = unwrapExpression(leftNode);
  const right = unwrapExpression(rightNode);
  if (!left || !right || depth <= 0 || left.type !== right.type) {
    return false;
  }
  if (left.type === "Literal") {
    return left.value === right.value;
  }
  if (left.type === "TemplateLiteral") {
    const text = templateText(left);
    return text !== null && text === templateText(right);
  }
  if (left.type === "Identifier") {
    return left.name === right.name;
  }
  if (left.type === "UnaryExpression") {
    return (
      left.operator === "-" &&
      right.operator === "-" &&
      literalNodesEqual(left.argument, right.argument, depth - 1)
    );
  }
  if (left.type === "ArrayExpression") {
    return (
      left.elements.length === right.elements.length &&
      left.elements.every((element, index) => {
        const other = right.elements[index];
        return (
          Boolean(element && other) &&
          element.type !== "SpreadElement" &&
          other.type !== "SpreadElement" &&
          literalNodesEqual(element, other, depth - 1)
        );
      })
    );
  }
  if (left.type === "ObjectExpression") {
    if (
      left.properties.length !== right.properties.length ||
      hasSpreadProperty(left) ||
      hasSpreadProperty(right)
    ) {
      return false;
    }
    const rightByKey = new Map();
    for (const property of right.properties) {
      rightByKey.set(propertyKeyName(property), property.value);
    }
    return left.properties.every((property) => {
      const key = propertyKeyName(property);
      return (
        key !== null &&
        rightByKey.has(key) &&
        literalNodesEqual(property.value, rightByKey.get(key), depth - 1)
      );
    });
  }
  return false;
}
