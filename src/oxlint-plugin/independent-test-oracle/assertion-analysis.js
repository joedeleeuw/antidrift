import {
  bareAssertionMethods,
  isBooleanLiteral,
  isMembershipAssertionNode,
  literalAtPath,
  literalContainerTypes,
  literalNodesEqual,
  matchesMockedResponseBody,
  resolutionDepthLimit,
  resolveLiteralNode,
  templateText,
  unwrapExpression,
  walkWithinBlock,
} from "../shared/test-block-arrangement.js";
import { staticPropertyName } from "../shared/test-files.js";
import {
  actForRoot,
  arrangedActForRoot,
  arrangedActPathForExpression,
  equalityOperands,
  isOutcomeFlagExpression,
  memberPathReference,
  pathsEqual,
} from "./assertion-paths.js";

const fullEqualityMatcherMethods = new Set(["toEqual", "toStrictEqual"]);
const fullEqualityMethods = new Set(["deepEqual", "deepStrictEqual"]);
const existenceMatcherMethods = new Set(["toBeDefined", "toBeTruthy"]);
const mockCallRecordMatcherMethods = new Set([
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toBeCalledWith",
  "lastCalledWith",
  "nthCalledWith",
]);
const mockCallCountMatcherMethods = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toBeCalled",
  "toBeCalledTimes",
]);
const throwingParseMethods = new Set(["parse", "parseAsync"]);

function isBooleanAssertMethod(method) {
  return bareAssertionMethods.has(method) || method === "assert";
}

function classifyOutcomeAssertion(record, facts) {
  if (record.kind === "assert" && isBooleanAssertMethod(record.method)) {
    const rawTarget = unwrapExpression(record.args[0]);
    const target =
      rawTarget?.type === "UnaryExpression" && rawTarget.operator === "!"
        ? unwrapExpression(rawTarget.argument)
        : rawTarget;
    return target && isOutcomeFlagExpression(target, facts.bindings)
      ? { independent: false, messageId: "outcomeEcho", node: record.node }
      : null;
  }
  const operands = equalityOperands(record);
  if (
    !operands?.actual ||
    !isBooleanLiteral(unwrapExpression(operands.expected)) ||
    !isOutcomeFlagExpression(operands.actual, facts.bindings)
  ) {
    return null;
  }
  return { independent: false, messageId: "outcomeEcho", node: record.node };
}

function isArrangedParseCall(node, bindings) {
  const call = unwrapExpression(node);
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "MemberExpression" &&
    throwingParseMethods.has(staticPropertyName(call.callee)) &&
    Boolean(arrangedActForRoot(call, bindings))
  );
}

function isArrangedThrowingParseSubject(record, bindings) {
  if (
    record.subject?.type === "ArrowFunctionExpression" ||
    record.subject?.type === "FunctionExpression"
  ) {
    let found = false;
    walkWithinBlock(record.subject.body, (node) => {
      if (!found && isArrangedParseCall(node, bindings)) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return (
    record.modifiers.has("rejects") &&
    isArrangedParseCall(record.subject, bindings)
  );
}

export function classifyErrorShapeAssertion(record, facts) {
  if (
    record.kind === "expect" &&
    record.matcher === "toThrow" &&
    isArrangedThrowingParseSubject(record, facts.bindings)
  ) {
    return {
      independent: false,
      messageId: "errorShapeEcho",
      node: record.node,
    };
  }
  const actual =
    record.kind === "expect"
      ? record.subject
      : equalityOperands(record)?.actual;
  const actPath =
    actual && arrangedActPathForExpression(actual, facts.bindings);
  if (!actPath) {
    return null;
  }
  const hasArrangedArg = actPath.act.arguments.some((argument) => {
    const expression = unwrapExpression(argument);
    return (
      expression?.type === "Identifier" ||
      literalContainerTypes.has(expression?.type)
    );
  });
  if (
    !hasArrangedArg ||
    !actPath.path.some((segment) => String(segment) === "error")
  ) {
    return null;
  }
  return {
    independent: false,
    messageId: "errorShapeEcho",
    node: record.node,
  };
}

function lengthAssertionParts(record) {
  if (record.kind === "expect" && record.matcher === "toHaveLength") {
    if (record.modifiers.has("not") || record.modifiers.has("rejects")) {
      return null;
    }
    return { collection: record.subject, count: record.args[0] ?? null };
  }
  const operands = equalityOperands(record);
  const pathReference =
    operands?.actual && memberPathReference(operands.actual);
  if (!pathReference || String(pathReference.path.at(-1)) !== "length") {
    return null;
  }
  return {
    collection: null,
    collectionReference: {
      root: pathReference.root,
      path: pathReference.path.slice(0, -1),
    },
    count: operands.expected,
  };
}

function classifyLengthAssertion(record, facts, sourceCode) {
  const parts = lengthAssertionParts(record);
  if (!parts) {
    return null;
  }
  const countNode = unwrapExpression(parts.count);
  const countReference =
    countNode?.type === "MemberExpression"
      ? memberPathReference(countNode)
      : null;
  if (
    countReference?.root?.type === "Identifier" &&
    String(countReference.path.at(-1)) === "length" &&
    facts.actArgNames.has(countReference.root.name)
  ) {
    return { independent: false, messageId: "lengthEcho", node: record.node };
  }
  if (countNode?.type !== "Literal" || typeof countNode.value !== "number") {
    return null;
  }
  const collectionReference =
    parts.collectionReference ?? memberPathReference(parts.collection);
  const act =
    collectionReference && actForRoot(collectionReference.root, facts.bindings);
  if (!act) {
    return null;
  }
  const matchesArrangedLength = act.arguments.some((argument) => {
    const target = literalAtPath(
      argument,
      collectionReference.path,
      sourceCode
    );
    return (
      target?.type === "ArrayExpression" &&
      target.elements.every(
        (element) => element && element.type !== "SpreadElement"
      ) &&
      target.elements.length === countNode.value
    );
  });
  return matchesArrangedLength
    ? { independent: false, messageId: "lengthEcho", node: record.node }
    : null;
}

function echoesActArgument(actualReference, expected, act, sourceCode) {
  const argNames = new Set();
  for (const argument of act.arguments) {
    const expression = unwrapExpression(argument);
    if (expression?.type === "Identifier") {
      argNames.add(expression.name);
    }
  }
  if (
    expected.type === "Identifier" &&
    actualReference.path.length === 0 &&
    argNames.has(expected.name)
  ) {
    return true;
  }
  const expectedReference = memberPathReference(expected);
  if (
    expectedReference?.root?.type === "Identifier" &&
    argNames.has(expectedReference.root.name) &&
    expectedReference.path.length > 0 &&
    pathsEqual(actualReference.path, expectedReference.path)
  ) {
    return true;
  }
  if (
    actualReference.path.length === 0 &&
    expected?.type === "ObjectExpression" &&
    expected.properties.length > 0 &&
    expected.properties.every((property) => {
      const source =
        property.type === "SpreadElement"
          ? unwrapExpression(property.argument)
          : null;
      return source?.type === "Identifier" && argNames.has(source.name);
    })
  ) {
    return true;
  }
  return act.arguments.some((argument) => {
    const target = literalAtPath(argument, actualReference.path, sourceCode);
    return Boolean(target) && literalNodesEqual(target, expected);
  });
}

function classifyInputEcho(record, facts, sourceCode) {
  const operands = equalityOperands(record);
  const actualReference =
    operands?.actual && memberPathReference(operands.actual);
  const act =
    actualReference && actForRoot(actualReference.root, facts.bindings);
  const expected = operands?.expected && unwrapExpression(operands.expected);
  if (
    !actualReference ||
    !act ||
    !expected ||
    !echoesActArgument(actualReference, expected, act, sourceCode)
  ) {
    return null;
  }
  return { independent: false, messageId: "inputEcho", node: record.node };
}

function isVacuousExistenceTarget(target, requireTruthy) {
  if (!target) {
    return false;
  }
  if (target.type === "ObjectExpression" || target.type === "ArrayExpression") {
    return true;
  }
  if (target.type === "Literal") {
    return requireTruthy ? Boolean(target.value) : true;
  }
  if (target.type === "TemplateLiteral") {
    const text = templateText(target);
    return requireTruthy ? Boolean(text) : true;
  }
  return false;
}

function classifyExistenceAssertion(record, sourceCode) {
  if (record.kind === "expect") {
    if (
      !existenceMatcherMethods.has(record.matcher) ||
      record.modifiers.size > 0
    ) {
      return null;
    }
    const target = resolveLiteralNode(
      record.subject,
      sourceCode,
      resolutionDepthLimit
    );
    return isVacuousExistenceTarget(target, record.matcher === "toBeTruthy")
      ? { independent: false, messageId: "existenceEcho", node: record.node }
      : null;
  }
  if (!isBooleanAssertMethod(record.method) || record.args.length !== 1) {
    return null;
  }
  const target = resolveLiteralNode(
    record.args[0],
    sourceCode,
    resolutionDepthLimit
  );
  return isVacuousExistenceTarget(target, true)
    ? { independent: false, messageId: "existenceEcho", node: record.node }
    : null;
}

function classifyMockAssertion(record, facts) {
  if (record.kind !== "expect") {
    return null;
  }
  if (mockCallCountMatcherMethods.has(record.matcher)) {
    return { independent: true, messageId: null, node: record.node };
  }
  if (!mockCallRecordMatcherMethods.has(record.matcher)) {
    return null;
  }
  if (record.modifiers.has("not")) {
    return { independent: true, messageId: null, node: record.node };
  }
  const callArgs =
    record.matcher === "toHaveBeenNthCalledWith" ||
    record.matcher === "nthCalledWith"
      ? record.args.slice(1)
      : record.args;
  const echoed = callArgs.some((argument) => {
    const expression = unwrapExpression(argument);
    if (expression?.type === "Identifier") {
      return facts.actArgNames.has(expression.name);
    }
    return facts.actArgLiterals.some((literal) =>
      literalNodesEqual(literal, expression)
    );
  });
  return echoed
    ? { independent: false, messageId: "mockCallEcho", node: record.node }
    : { independent: true, messageId: null, node: record.node };
}

function classifyAssertion(record, facts, sourceCode) {
  const errorShape = classifyErrorShapeAssertion(record, facts);
  if (errorShape) {
    return errorShape;
  }
  if (isMembershipAssertionNode(record.node)) {
    return { independent: false, messageId: null, node: record.node };
  }
  if (matchesMockedResponseBody(record, facts, sourceCode)) {
    return {
      independent: false,
      messageId: "mockedResponseBodyOracle",
      node: record.node,
    };
  }
  return (
    classifyMockAssertion(record, facts) ??
    classifyLengthAssertion(record, facts, sourceCode) ??
    classifyOutcomeAssertion(record, facts) ??
    classifyInputEcho(record, facts, sourceCode) ??
    classifyExistenceAssertion(record, sourceCode) ?? {
      independent: true,
      messageId: null,
      node: record.node,
    }
  );
}

function fullEqualityCollectionReference(record, sourceCode) {
  const deep =
    record.kind === "expect"
      ? fullEqualityMatcherMethods.has(record.matcher)
      : fullEqualityMethods.has(record.method);
  if (!deep) {
    return null;
  }
  const operands = equalityOperands(record);
  if (!operands?.actual) {
    return null;
  }
  const expected = resolveLiteralNode(
    operands.expected,
    sourceCode,
    resolutionDepthLimit
  );
  return expected?.type === "ArrayExpression"
    ? memberPathReference(operands.actual)
    : null;
}

function hasIndependentContentsOracle(
  lengthRecord,
  assertionResults,
  sourceCode
) {
  const parts = lengthAssertionParts(lengthRecord);
  const collection =
    parts &&
    (parts.collectionReference ?? memberPathReference(parts.collection));
  if (!collection) {
    return false;
  }
  return assertionResults.some((assertionResult) => {
    if (
      !assertionResult.independent ||
      assertionResult.record === lengthRecord
    ) {
      return false;
    }
    const equalityReference = fullEqualityCollectionReference(
      assertionResult.record,
      sourceCode
    );
    return (
      Boolean(equalityReference) &&
      collection.root.type === "Identifier" &&
      equalityReference.root.type === "Identifier" &&
      collection.root.name === equalityReference.root.name &&
      pathsEqual(collection.path, equalityReference.path)
    );
  });
}

export function analyzeTestBlock(facts, context, sourceCode) {
  if (facts.assertions.length === 0) {
    return;
  }
  const assertionResults = facts.assertions.map((record) => ({
    ...classifyAssertion(record, facts, sourceCode),
    record,
  }));
  for (const assertionResult of assertionResults) {
    if (!assertionResult.messageId) {
      continue;
    }
    if (
      assertionResult.messageId === "lengthEcho" &&
      hasIndependentContentsOracle(
        assertionResult.record,
        assertionResults,
        sourceCode
      )
    ) {
      continue;
    }
    context.report({
      node: assertionResult.node,
      messageId: assertionResult.messageId,
    });
  }
}
