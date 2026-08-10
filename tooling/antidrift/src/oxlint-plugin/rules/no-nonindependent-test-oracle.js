import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";

const booleanValues = new Set([true, false]);
const equalityMethods = new Set([
  "deepEqual",
  "deepStrictEqual",
  "equal",
  "strictEqual",
]);
const bareAssertionMethods = new Set(["ok"]);
const booleanMatcherMethods = new Set(["toBe", "toEqual", "toStrictEqual"]);
const equalityMatcherMethods = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
]);
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
const testBlockNames = new Set(["it", "test", "xit", "xtest", "fit"]);
const literalContainerTypes = new Set([
  "ObjectExpression",
  "ArrayExpression",
  "Literal",
  "TemplateLiteral",
]);
const resolutionDepthLimit = 8;
const testFilenamePattern =
  /(?:(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.][cm]?[jt]sx?$)/u;

function contextFilename(context) {
  if (typeof context.getFilename === "function") return context.getFilename();
  return context.filename ?? "";
}

function isTestFilename(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") {
    return true;
  }
  return testFilenamePattern.test(filename);
}

function staticPropertyName(member) {
  if (member?.type !== "MemberExpression") return "";
  const property = member.property;
  if (!member.computed && property?.type === "Identifier") return property.name;
  if (property?.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return "";
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  return staticPropertyName(callee);
}

function unwrapExpression(node) {
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

function isBooleanLiteral(node) {
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
  if (method === "hasOwnProperty") return true;
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
      statement.type === "ReturnStatement" && Boolean(statement.argument),
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
  if (node.type !== "CallExpression") return false;
  const name = calleeName(node.callee);
  if (
    equalityMethods.has(name) &&
    isMembershipPredicate(node.arguments[0]) &&
    isBooleanLiteral(node.arguments[1])
  ) {
    return true;
  }
  if (
    bareAssertionMethods.has(name) &&
    (isMembershipPredicate(node.arguments[0]) ||
      isNegatedMembershipPredicate(node.arguments[0]))
  ) {
    return true;
  }
  if (
    name === "assert" &&
    (isMembershipPredicate(node.arguments[0]) ||
      isNegatedMembershipPredicate(node.arguments[0]))
  ) {
    return true;
  }
  return false;
}

function isMembershipMatcherAssertion(node) {
  const record = parseExpectAssertion(node);
  if (!record) return false;
  const matcher = record.matcher;
  if (matcher === "toContain") return true;
  if (matcher === "toHaveProperty") return record.args.length <= 1;
  if (
    !booleanMatcherMethods.has(matcher) ||
    !isBooleanLiteral(record.args[0])
  ) {
    return false;
  }
  return isMembershipPredicate(record.subject);
}

function isMembershipAssertionNode(node) {
  return isBareMembershipAssertion(node) || isMembershipMatcherAssertion(node);
}

function isTestBlockCallee(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") return testBlockNames.has(callee.name);
  if (callee.type === "MemberExpression") {
    return isTestBlockCallee(callee.object);
  }
  if (callee.type === "CallExpression") return isTestBlockCallee(callee.callee);
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

function enclosingTestBlockCallback(node) {
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

function isNodeLike(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.type === "string"
  );
}

function pushChildNodes(node, stack) {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (isNodeLike(child) && !testBlockCallback(child)) stack.push(child);
    }
  }
}

function walkWithinBlock(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    visit(node);
    pushChildNodes(node, stack);
  }
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

function parseExpectAssertion(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return null;
  }
  const matcher = staticPropertyName(node.callee);
  if (!matcher) return null;
  const modifiers = new Set();
  let current = unwrapExpression(node.callee.object);
  while (current?.type === "MemberExpression") {
    modifiers.add(staticPropertyName(current));
    current = unwrapExpression(current.object);
  }
  const expectCall = expectRootCall(current);
  if (!expectCall) return null;
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

function parseAssertAssertion(node) {
  if (node.type !== "CallExpression") return null;
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

function bindingCall(init) {
  let expression = unwrapExpression(init);
  if (expression?.type === "AwaitExpression") {
    expression = unwrapExpression(expression.argument);
  }
  return expression?.type === "CallExpression" ? expression : null;
}

function recordActBinding(declarator, bindings) {
  if (declarator.id?.type !== "Identifier" || !declarator.init) return;
  bindings.set(declarator.id.name, declarator.init);
}

function collectActArgument(argument, names, literals) {
  const expression = unwrapExpression(argument);
  if (!expression) return;
  if (expression.type === "Identifier") {
    names.add(expression.name);
    return;
  }
  if (literalContainerTypes.has(expression.type)) literals.push(expression);
}

function collectBlockFacts(callback) {
  const calls = [];
  const bindings = new Map();
  walkWithinBlock(callback.body, (node) => {
    if (node.type === "CallExpression") calls.push(node);
    else if (node.type === "VariableDeclarator") {
      recordActBinding(node, bindings);
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
  const actArgNames = new Set();
  const actArgLiterals = [];
  for (const call of calls) {
    if (assertionCalls.has(call)) continue;
    for (const argument of call.arguments) {
      collectActArgument(argument, actArgNames, actArgLiterals);
    }
  }
  return { assertions, bindings, actArgNames, actArgLiterals };
}

function constInitializer(sourceCode, identifier) {
  const variable = findVariable(sourceCode, identifier);
  const definition = variable?.defs?.[0];
  if (
    definition?.type !== "Variable" ||
    definition.node?.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const"
  ) {
    return null;
  }
  return definition.node.init ?? null;
}

function resolveLiteralNode(node, sourceCode, depth) {
  const expression = unwrapExpression(node);
  if (!expression || depth <= 0) return null;
  if (expression.type === "Identifier") {
    const init = constInitializer(sourceCode, expression);
    return init ? resolveLiteralNode(init, sourceCode, depth - 1) : null;
  }
  return literalContainerTypes.has(expression.type) ? expression : null;
}

function propertyKeyName(property) {
  if (property.type !== "Property") return null;
  if (property.computed) {
    return property.key.type === "Literal" ? String(property.key.value) : null;
  }
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return null;
}

function objectPropertyValue(objectExpression, segment, sourceCode, depth) {
  let result = null;
  for (const property of objectExpression.properties) {
    if (property.type === "SpreadElement") {
      const spread = resolveLiteralNode(
        property.argument,
        sourceCode,
        depth - 1,
      );
      if (spread?.type !== "ObjectExpression") continue;
      const inherited = objectPropertyValue(
        spread,
        segment,
        sourceCode,
        depth - 1,
      );
      if (inherited) result = inherited;
      continue;
    }
    if (propertyKeyName(property) === String(segment)) result = property.value;
  }
  return result;
}

function literalStep(container, segment, sourceCode, depth) {
  if (container.type === "ObjectExpression") {
    return objectPropertyValue(container, segment, sourceCode, depth);
  }
  if (container.type === "ArrayExpression" && typeof segment === "number") {
    const hasSpread = container.elements.some(
      (element) => element?.type === "SpreadElement",
    );
    return hasSpread ? null : (container.elements[segment] ?? null);
  }
  return null;
}

function literalAtPath(baseNode, path, sourceCode) {
  let depth = resolutionDepthLimit;
  let current = resolveLiteralNode(baseNode, sourceCode, depth);
  for (const segment of path) {
    if (!current || depth <= 0) return null;
    depth -= 1;
    const next = literalStep(current, segment, sourceCode, depth);
    current = next
      ? (resolveLiteralNode(next, sourceCode, depth) ?? unwrapExpression(next))
      : null;
  }
  return current;
}

function templateText(template) {
  if (template.expressions.length > 0) return null;
  return template.quasis.map((quasi) => quasi.value.cooked).join("");
}

function hasSpreadProperty(objectExpression) {
  return objectExpression.properties.some(
    (property) => property.type === "SpreadElement",
  );
}

function arrayLiteralsEqual(left, right, depth) {
  if (left.elements.length !== right.elements.length) return false;
  return left.elements.every((element, index) => {
    const other = right.elements[index];
    if (!element || !other) return false;
    if (element.type === "SpreadElement" || other.type === "SpreadElement") {
      return false;
    }
    return literalNodesEqual(element, other, depth - 1);
  });
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
    if (key === null || !rightByKey.has(key)) return false;
    return literalNodesEqual(property.value, rightByKey.get(key), depth - 1);
  });
}

function literalNodesEqual(a, b, depth = resolutionDepthLimit) {
  const left = unwrapExpression(a);
  const right = unwrapExpression(b);
  if (!left || !right || depth <= 0 || left.type !== right.type) return false;
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
  if (left.type === "ObjectExpression") {
    return objectLiteralsEqual(left, right, depth);
  }
  return false;
}

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
    if (segment === null) return null;
    path.unshift(segment);
    current = unwrapExpression(current.object);
  }
  return current ? { root: current, path } : null;
}

function actForRoot(root, bindings) {
  if (!root) return null;
  if (root.type === "CallExpression") return root;
  if (root.type === "Identifier") {
    return bindingCall(bindings.get(root.name)) ?? null;
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
  depth = resolutionDepthLimit,
) {
  const target = unwrapExpression(expression);
  if (!target || depth <= 0) return null;
  if (target.type === "Identifier") {
    const act = arrangedActForRoot(target, bindings);
    if (act) return { act, path: [] };
    const binding = bindings.get(target.name);
    return binding
      ? arrangedActPathForExpression(binding, bindings, depth - 1)
      : null;
  }
  if (target.type === "MemberExpression") {
    const info = memberPathInfo(target);
    if (!info) return null;
    const base = arrangedActPathForExpression(info.root, bindings, depth - 1);
    return base ? { act: base.act, path: [...base.path, ...info.path] } : null;
  }
  if (
    target.type === "CallExpression" &&
    target.callee.type === "MemberExpression"
  ) {
    const base = arrangedActPathForExpression(
      target.callee.object,
      bindings,
      depth - 1,
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
    if (!equalityMatcherMethods.has(record.matcher)) return null;
    if (record.modifiers.has("not") || record.modifiers.has("rejects")) {
      return null;
    }
    return { actual: record.subject, expected: record.args[0] ?? null };
  }
  if (!equalityMethods.has(record.method)) return null;
  return {
    actual: record.args[0] ? unwrapExpression(record.args[0]) : null,
    expected: record.args[1] ?? null,
  };
}

function stripNegation(expression) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type === "UnaryExpression" && unwrapped.operator === "!") {
    return unwrapExpression(unwrapped.argument);
  }
  return unwrapped;
}

function isOutcomeFlagExpression(expression, bindings) {
  const info = memberPathInfo(expression);
  if (
    info &&
    info.path.length > 0 &&
    outcomeFlagProperties.has(String(info.path.at(-1)))
  ) {
    return Boolean(arrangedActForRoot(info.root, bindings));
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
    const target = stripNegation(record.args[0]);
    if (target && isOutcomeFlagExpression(target, facts.bindings)) {
      return {
        independent: false,
        messageId: "outcomeEcho",
        node: record.node,
      };
    }
    return null;
  }
  const operands = equalityOperands(record);
  if (
    !operands?.actual ||
    !isBooleanLiteral(unwrapExpression(operands.expected))
  ) {
    return null;
  }
  if (!isOutcomeFlagExpression(operands.actual, facts.bindings)) return null;
  return { independent: false, messageId: "outcomeEcho", node: record.node };
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
  if (!actual) return null;
  const info = arrangedActPathForExpression(actual, facts.bindings);
  if (!info?.path.some((segment) => String(segment) === "error")) return null;
  return {
    independent: false,
    messageId: "errorShapeEcho",
    node: record.node,
  };
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

function functionContainsArrangedParse(subject, bindings) {
  if (
    subject?.type !== "ArrowFunctionExpression" &&
    subject?.type !== "FunctionExpression"
  ) {
    return false;
  }
  let found = false;
  walkWithinBlock(subject.body, (node) => {
    if (!found && isArrangedParseCall(node, bindings)) found = true;
  });
  return found;
}

function isArrangedThrowingParseSubject(record, bindings) {
  if (functionContainsArrangedParse(record.subject, bindings)) return true;
  return (
    record.modifiers.has("rejects") &&
    isArrangedParseCall(record.subject, bindings)
  );
}

function arrangedArrayLength(info, expectedCount, facts, sourceCode) {
  const act = actForRoot(info.root, facts.bindings);
  if (!act) return false;
  return act.arguments.some((argument) => {
    const target = literalAtPath(argument, info.path, sourceCode);
    if (target?.type !== "ArrayExpression") return false;
    const countable = target.elements.every(
      (element) => element && element.type !== "SpreadElement",
    );
    return countable && target.elements.length === expectedCount;
  });
}

function lengthAssertionParts(record) {
  if (record.kind === "expect" && record.matcher === "toHaveLength") {
    if (record.modifiers.has("not") || record.modifiers.has("rejects")) {
      return null;
    }
    return { collection: record.subject, count: record.args[0] ?? null };
  }
  const operands = equalityOperands(record);
  if (!operands?.actual) return null;
  const info = memberPathInfo(operands.actual);
  if (!info || String(info.path.at(-1)) !== "length") return null;
  return {
    collection: null,
    collectionInfo: { root: info.root, path: info.path.slice(0, -1) },
    count: operands.expected,
  };
}

function countEchoesArgLength(countNode, facts) {
  if (countNode?.type !== "MemberExpression") return false;
  const info = memberPathInfo(countNode);
  return (
    info?.root?.type === "Identifier" &&
    String(info.path.at(-1)) === "length" &&
    facts.actArgNames.has(info.root.name)
  );
}

function classifyLengthAssertion(record, facts, sourceCode) {
  const parts = lengthAssertionParts(record);
  if (!parts) return null;
  const countNode = unwrapExpression(parts.count);
  if (countEchoesArgLength(countNode, facts)) {
    return { independent: false, messageId: "lengthEcho", node: record.node };
  }
  if (countNode?.type !== "Literal" || typeof countNode.value !== "number") {
    return null;
  }
  const info = parts.collectionInfo ?? memberPathInfo(parts.collection);
  if (!info) return null;
  if (!arrangedArrayLength(info, countNode.value, facts, sourceCode)) {
    return null;
  }
  return { independent: false, messageId: "lengthEcho", node: record.node };
}

function isSpreadCloneOfActArgs(expression, argNames) {
  if (
    expression?.type !== "ObjectExpression" ||
    expression.properties.length === 0
  ) {
    return false;
  }
  return expression.properties.every((property) => {
    if (property.type !== "SpreadElement") return false;
    const source = unwrapExpression(property.argument);
    return source?.type === "Identifier" && argNames.has(source.name);
  });
}

function actArgumentNames(act) {
  const names = new Set();
  for (const argument of act.arguments) {
    const expression = unwrapExpression(argument);
    if (expression?.type === "Identifier") names.add(expression.name);
  }
  return names;
}

function echoesActArgument(actualInfo, expected, act, sourceCode) {
  const argNames = actArgumentNames(act);
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
    isSpreadCloneOfActArgs(expected, argNames)
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
  if (!operands?.actual || !operands.expected) return null;
  const actualInfo = memberPathInfo(operands.actual);
  if (!actualInfo) return null;
  const act = actForRoot(actualInfo.root, facts.bindings);
  if (!act) return null;
  const expected = unwrapExpression(operands.expected);
  if (!expected || !echoesActArgument(actualInfo, expected, act, sourceCode)) {
    return null;
  }
  return { independent: false, messageId: "inputEcho", node: record.node };
}

function isVacuousExistenceTarget(target, requireTruthy) {
  if (!target) return false;
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
      resolutionDepthLimit,
    );
    if (!isVacuousExistenceTarget(target, record.matcher === "toBeTruthy")) {
      return null;
    }
    return {
      independent: false,
      messageId: "existenceEcho",
      node: record.node,
    };
  }
  if (!isBooleanAssertMethod(record.method)) return null;
  if (record.args.length !== 1) return null;
  const target = resolveLiteralNode(
    record.args[0],
    sourceCode,
    resolutionDepthLimit,
  );
  if (!isVacuousExistenceTarget(target, true)) return null;
  return { independent: false, messageId: "existenceEcho", node: record.node };
}

function mockRecordArguments(record) {
  if (
    record.matcher === "toHaveBeenNthCalledWith" ||
    record.matcher === "nthCalledWith"
  ) {
    return record.args.slice(1);
  }
  return record.args;
}

function classifyMockAssertion(record, facts) {
  if (record.kind !== "expect") return null;
  if (mockCallCountMatcherMethods.has(record.matcher)) {
    return { independent: true, messageId: null, node: record.node };
  }
  if (!mockCallRecordMatcherMethods.has(record.matcher)) return null;
  if (record.modifiers.has("not")) {
    return { independent: true, messageId: null, node: record.node };
  }
  const echoed = mockRecordArguments(record).some((argument) => {
    const expression = unwrapExpression(argument);
    if (expression?.type === "Identifier") {
      return facts.actArgNames.has(expression.name);
    }
    return facts.actArgLiterals.some((literal) =>
      literalNodesEqual(literal, expression),
    );
  });
  if (!echoed) return { independent: true, messageId: null, node: record.node };
  return { independent: false, messageId: "mockCallEcho", node: record.node };
}

function classifyAssertion(record, facts, sourceCode) {
  const errorShape = classifyErrorShapeAssertion(record, facts);
  if (errorShape) return errorShape;
  if (isMembershipAssertionNode(record.node)) {
    return { independent: false, messageId: null, node: record.node };
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

function analyzeTestBlock(callback, context, sourceCode) {
  const facts = collectBlockFacts(callback);
  if (facts.assertions.length === 0) return;
  const classified = facts.assertions.map((record) =>
    classifyAssertion(record, facts, sourceCode),
  );
  for (const result of classified) {
    if (result.messageId) {
      context.report({ node: result.node, messageId: result.messageId });
    }
  }
}

export default function ruleNoNonindependentTestOracle() {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Disallow tests whose assertions restate their own arrangement or reduce to bare membership, dependency pass/fail or error shapes, or vacuous existence checks",
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
      },
    },
    create(context) {
      if (!isTestFilename(contextFilename(context))) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        CallExpression(node) {
          if (isMembershipAssertionNode(node)) {
            const callback = enclosingTestBlockCallback(node);
            const record =
              parseExpectAssertion(node) ?? parseAssertAssertion(node);
            if (
              callback &&
              record &&
              classifyErrorShapeAssertion(record, collectBlockFacts(callback))
            ) {
              return;
            }
            context.report({ node, messageId: "noBareMembership" });
            return;
          }
          const callback = testBlockCallback(node);
          if (callback) analyzeTestBlock(callback, context, sourceCode);
        },
      };
    },
  };
}
