import {
  constInitializer,
  staticPropertyName,
  unwrapAwaitedExpression,
  unwrapExpression,
} from "./scope.js";

export const literalContainerTypes = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
]);
export const resolutionDepthLimit = 8;
const shapeMatcherMethods = new Set([
  "toEqual",
  "toMatchObject",
  "toStrictEqual",
]);
const shapeFactories = new Set(["arrayContaining", "objectContaining"]);

export function isFunctionNode(node) {
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

function constInitializerWithin(sourceCode, identifier, callback) {
  const initializer = constInitializer(sourceCode, identifier);
  if (
    initializer === null ||
    (callback && nearestFunction(initializer) !== callback)
  ) {
    return null;
  }
  return initializer;
}

export function templateText(template) {
  if (template.expressions.length > 0) {
    return null;
  }
  return template.quasis.map((quasi) => quasi.value.cooked).join("");
}

function propertyKeyName(property) {
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

function resolveObjectShape(node, state) {
  const properties = [];
  for (const property of node.properties) {
    if (property.type !== "Property" || property.kind !== "init") {
      return null;
    }
    const key = propertyKeyName(property);
    const propertyShape = resolveStaticShape(property.value, {
      ...state,
      depth: state.depth + 1,
      seen: new Set(state.seen),
    });
    if (key === null || !propertyShape) {
      return null;
    }
    properties.push([key, propertyShape.shape]);
  }
  properties.sort(([left], [right]) => left.localeCompare(right));
  return { shape: { kind: "object", properties }, partial: false };
}

function resolveArrayShape(node, state) {
  const elementShapes = [];
  for (const element of node.elements) {
    if (!element || element.type === "SpreadElement") {
      return null;
    }
    const resolvedElement = resolveStaticShape(element, {
      ...state,
      depth: state.depth + 1,
      seen: new Set(state.seen),
    });
    if (!resolvedElement) {
      return null;
    }
    elementShapes.push(resolvedElement.shape);
  }
  return { shape: { kind: "array", elementShapes }, partial: false };
}

export function resolveStaticShape(expression, state) {
  const { callback, sourceCode, depth = 0, seen = new Set() } = state;
  if (depth > resolutionDepthLimit) {
    return null;
  }
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) {
    return null;
  }
  seen.add(node);
  const nextState = { callback, sourceCode, depth, seen };
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
    return resolveObjectShape(node, nextState);
  }
  if (node.type === "ArrayExpression") {
    return resolveArrayShape(node, nextState);
  }
  if (isShapeFactoryCall(node)) {
    const nested = node.arguments[0]
      ? resolveStaticShape(node.arguments[0], {
          ...nextState,
          depth: depth + 1,
        })
      : null;
    return nested ? { ...nested, partial: true } : null;
  }
  if (node.type !== "Identifier") {
    return null;
  }
  const initializer = constInitializerWithin(sourceCode, node, callback);
  return initializer
    ? resolveStaticShape(initializer, { ...nextState, depth: depth + 1 })
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

function derivesFromResponseJson(expression, state) {
  const { callback, sourceCode, depth = 0, seen = new Set() } = state;
  if (depth > resolutionDepthLimit) {
    return false;
  }
  const node = unwrapAwaitedExpression(expression);
  if (!node || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const nextState = { callback, sourceCode, depth: depth + 1, seen };
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    staticPropertyName(node.callee) === "json"
  ) {
    return true;
  }
  if (node.type === "Identifier") {
    const initializer = constInitializerWithin(sourceCode, node, callback);
    return initializer
      ? derivesFromResponseJson(initializer, nextState)
      : false;
  }
  if (node.type === "MemberExpression") {
    return derivesFromResponseJson(node.object, nextState);
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
  const expected = resolveStaticShape(record.args[0], {
    callback: facts.callback,
    sourceCode,
  });
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
    derivesFromResponseJson(record.subject, {
      callback: facts.callback,
      sourceCode,
    })
  );
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

function objectLiteralsEqual(left, right, depth) {
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

function arrayLiteralsEqual(left, right, depth) {
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
  if (left.type === "Literal") return left.value === right.value;
  if (left.type === "TemplateLiteral") {
    const text = templateText(left);
    return text !== null && text === templateText(right);
  }
  if (left.type === "Identifier") return left.name === right.name;
  if (left.type === "UnaryExpression") {
    return (
      left.operator === "-" &&
      right.operator === "-" &&
      literalNodesEqual(left.argument, right.argument, depth - 1)
    );
  }
  if (left.type === "ArrayExpression") {
    return arrayLiteralsEqual(left, right, depth);
  }
  return left.type === "ObjectExpression"
    ? objectLiteralsEqual(left, right, depth)
    : false;
}
