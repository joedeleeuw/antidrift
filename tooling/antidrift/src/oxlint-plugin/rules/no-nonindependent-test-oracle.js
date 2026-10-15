import {
  bareAssertionMethods,
  collectBlockFacts,
  enclosingTestBlockCallback,
  equalityMatcherMethods,
  equalityMethods,
  isBooleanLiteral,
  isMembershipAssertionNode,
  literalAtPath,
  literalContainerTypes,
  literalNodesEqual,
  matchesMockedResponseBody,
  parseAssertAssertion,
  parseExpectAssertion,
  resolutionDepthLimit,
  resolveLiteralNode,
  templateText,
  testBlockCallback,
  unwrapAwaitedExpression,
  unwrapExpression,
  walkWithinBlock,
} from "../shared/test-block-arrangement.js";
import {
  contextFilename,
  isTestFilename,
  staticPropertyName,
} from "../shared/test-files.js";

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
const outcomeFlagProperties = new Set(["success", "ok"]);
const outcomeFlagMethods = new Set(["isOk", "isErr", "isSuccess", "isFailure"]);
const throwingParseMethods = new Set(["parse", "parseAsync"]);

function memberSegment(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (
    member.property.type === "Literal" &&
    (typeof member.property.value === "string" ||
      typeof member.property.value === "number")
  ) {
    return member.property.value;
  }
  return null;
}

function memberPathInfo(expression) {
  const path = [];
  let current = unwrapExpression(expression);
  while (current?.type === "MemberExpression") {
    const segment = memberSegment(current);
    if (segment === null) {
      return null;
    }
    path.unshift(segment);
    current = unwrapExpression(current.object);
  }
  return current ? { root: current, path } : null;
}

function actForRoot(root, bindings) {
  if (!root) {
    return null;
  }
  if (root.type === "CallExpression") {
    return root;
  }
  if (root.type === "Identifier") {
    const bound = unwrapAwaitedExpression(bindings.get(root.name));
    return bound?.type === "CallExpression" ? bound : null;
  }
  return null;
}

function arrangedActForRoot(root, bindings) {
  const act = actForRoot(root, bindings);
  return act && act.arguments.length > 0 ? act : null;
}

function arrangedActPathForExpression(
  expression,
  bindings,
  depth = resolutionDepthLimit
) {
  const target = unwrapExpression(expression);
  if (!target || depth <= 0) {
    return null;
  }
  if (target.type === "Identifier") {
    const act = arrangedActForRoot(target, bindings);
    if (act) {
      return { act, path: [] };
    }
    const binding = bindings.get(target.name);
    return binding
      ? arrangedActPathForExpression(binding, bindings, depth - 1)
      : null;
  }
  if (target.type === "MemberExpression") {
    const pathInfo = memberPathInfo(target);
    if (!pathInfo) {
      return null;
    }
    const base = arrangedActPathForExpression(
      pathInfo.root,
      bindings,
      depth - 1
    );
    return base
      ? { act: base.act, path: [...base.path, ...pathInfo.path] }
      : null;
  }
  if (
    target.type === "CallExpression" &&
    target.callee.type === "MemberExpression"
  ) {
    const base = arrangedActPathForExpression(
      target.callee.object,
      bindings,
      depth - 1
    );
    if (base) {
      const method = staticPropertyName(target.callee);
      return method ? { act: base.act, path: [...base.path, method] } : null;
    }
  }
  const act = arrangedActForRoot(target, bindings);
  return act ? { act, path: [] } : null;
}

function pathsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((segment, index) => String(segment) === String(right[index]))
  );
}

function equalityOperands(record) {
  if (record.kind === "expect") {
    if (
      !equalityMatcherMethods.has(record.matcher) ||
      record.modifiers.has("not") ||
      record.modifiers.has("rejects")
    ) {
      return null;
    }
    return { actual: record.subject, expected: record.args[0] ?? null };
  }
  if (!equalityMethods.has(record.method)) {
    return null;
  }
  return {
    actual: record.args[0] ? unwrapExpression(record.args[0]) : null,
    expected: record.args[1] ?? null,
  };
}

function isOutcomeFlagExpression(expression, bindings) {
  const pathInfo = memberPathInfo(expression);
  if (
    pathInfo &&
    pathInfo.path.length > 0 &&
    outcomeFlagProperties.has(String(pathInfo.path.at(-1)))
  ) {
    return Boolean(arrangedActForRoot(pathInfo.root, bindings));
  }
  const call = unwrapExpression(expression);
  if (
    call?.type !== "CallExpression" ||
    call.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const receiverInfo = memberPathInfo(call.callee.object);
  return (
    outcomeFlagMethods.has(staticPropertyName(call.callee)) &&
    call.arguments.length === 0 &&
    Boolean(receiverInfo && arrangedActForRoot(receiverInfo.root, bindings))
  );
}

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

function classifyErrorShapeAssertion(record, facts) {
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
  const pathInfo = operands?.actual && memberPathInfo(operands.actual);
  if (!pathInfo || String(pathInfo.path.at(-1)) !== "length") {
    return null;
  }
  return {
    collection: null,
    collectionInfo: { root: pathInfo.root, path: pathInfo.path.slice(0, -1) },
    count: operands.expected,
  };
}

function classifyLengthAssertion(record, facts, sourceCode) {
  const parts = lengthAssertionParts(record);
  if (!parts) {
    return null;
  }
  const countNode = unwrapExpression(parts.count);
  const countInfo =
    countNode?.type === "MemberExpression" ? memberPathInfo(countNode) : null;
  if (
    countInfo?.root?.type === "Identifier" &&
    String(countInfo.path.at(-1)) === "length" &&
    facts.actArgNames.has(countInfo.root.name)
  ) {
    return { independent: false, messageId: "lengthEcho", node: record.node };
  }
  if (countNode?.type !== "Literal" || typeof countNode.value !== "number") {
    return null;
  }
  const collectionInfo =
    parts.collectionInfo ?? memberPathInfo(parts.collection);
  const act = collectionInfo && actForRoot(collectionInfo.root, facts.bindings);
  if (!act) {
    return null;
  }
  const matchesArrangedLength = act.arguments.some((argument) => {
    const target = literalAtPath(argument, collectionInfo.path, sourceCode);
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

function echoesActArgument(actualInfo, expected, act, sourceCode) {
  const argNames = new Set();
  for (const argument of act.arguments) {
    const expression = unwrapExpression(argument);
    if (expression?.type === "Identifier") {
      argNames.add(expression.name);
    }
  }
  if (
    expected.type === "Identifier" &&
    actualInfo.path.length === 0 &&
    argNames.has(expected.name)
  ) {
    return true;
  }
  const expectedInfo = memberPathInfo(expected);
  if (
    expectedInfo?.root?.type === "Identifier" &&
    argNames.has(expectedInfo.root.name) &&
    expectedInfo.path.length > 0 &&
    pathsEqual(actualInfo.path, expectedInfo.path)
  ) {
    return true;
  }
  if (
    actualInfo.path.length === 0 &&
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
    const target = literalAtPath(argument, actualInfo.path, sourceCode);
    return Boolean(target) && literalNodesEqual(target, expected);
  });
}

function classifyInputEcho(record, facts, sourceCode) {
  const operands = equalityOperands(record);
  const actualInfo = operands?.actual && memberPathInfo(operands.actual);
  const act = actualInfo && actForRoot(actualInfo.root, facts.bindings);
  const expected = operands?.expected && unwrapExpression(operands.expected);
  if (
    !actualInfo ||
    !act ||
    !expected ||
    !echoesActArgument(actualInfo, expected, act, sourceCode)
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

function fullEqualityCollectionInfo(record, sourceCode) {
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
    ? memberPathInfo(operands.actual)
    : null;
}

function hasIndependentContentsOracle(
  lengthRecord,
  assertionResults,
  sourceCode
) {
  const parts = lengthAssertionParts(lengthRecord);
  const collection =
    parts && (parts.collectionInfo ?? memberPathInfo(parts.collection));
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
    const contents = fullEqualityCollectionInfo(
      assertionResult.record,
      sourceCode
    );
    return (
      Boolean(contents) &&
      collection.root.type === "Identifier" &&
      contents.root.type === "Identifier" &&
      collection.root.name === contents.root.name &&
      pathsEqual(collection.path, contents.path)
    );
  });
}

function analyzeTestBlock(facts, context, sourceCode) {
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

export default function ruleNoNonindependentTestOracle() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow tests whose assertions restate their own arrangement or mock response body, or reduce to bare membership, dependency pass/fail or error shapes, or vacuous existence checks",
      },
      schema: [],
      messages: {
        noBareMembership:
          "Do not make bare membership or key existence the test. Assert behavior, full output, or a real artifact instead.",
        inputEcho:
          "This assertion restates the arranged input, so it only proves the dependency echoed data back. Assert transformed output, a captured artifact, or boundary behavior instead.",
        lengthEcho:
          "This length assertion restates the arranged collection size and proves no project transform or filter. Assert transformed contents or an independently derived count instead.",
        outcomeEcho:
          "This assertion only inspects the outcome or error of an act on input the test arranged to fail. Assert the parsed value on the success path, or a downstream consumer's behavior — inspecting the validator's own error/flag proves nothing the arrangement didn't.",
        errorShapeEcho:
          "This assertion only inspects the outcome or error of an act on input the test arranged to fail. Assert the parsed value on the success path, or a downstream consumer's behavior — inspecting the validator's own error/flag proves nothing the arrangement didn't.",
        existenceEcho:
          "This existence check is satisfied by the arranged value's construction and cannot fail. Assert real output instead.",
        mockCallEcho:
          "This test only proves the mock received the argument the test itself passed. Assert output, state, or an effect beyond the mocked call.",
        mockedResponseBodyOracle:
          "This test asserts a response-body object shape supplied by a mock. Object-shape checks are candidates for deleting the entire test block, not for swapping schema.parse with direct equality. Keep the test only if it proves an independently owned effect. Tip: checking response-body or payload shapes is often a sign of a low-value test; assert behavior not supplied by the mock or remove the test.",
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) {
        return {};
      }
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const factsByCallback = new WeakMap();
      const blockFacts = (callback) => {
        let facts = factsByCallback.get(callback);
        if (!facts) {
          facts = collectBlockFacts(callback, sourceCode);
          factsByCallback.set(callback, facts);
        }
        return facts;
      };
      return {
        CallExpression(node) {
          if (isMembershipAssertionNode(node)) {
            const callback = enclosingTestBlockCallback(node);
            const record =
              parseExpectAssertion(node) ?? parseAssertAssertion(node);
            if (
              callback &&
              record &&
              classifyErrorShapeAssertion(record, blockFacts(callback))
            ) {
              return;
            }
            context.report({ node, messageId: "noBareMembership" });
            return;
          }
          const callback = testBlockCallback(node);
          if (callback) {
            analyzeTestBlock(blockFacts(callback), context, sourceCode);
          }
        },
      };
    },
  };
}
