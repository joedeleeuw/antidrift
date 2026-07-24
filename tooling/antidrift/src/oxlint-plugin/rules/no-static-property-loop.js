import { findVariable } from "../../semantic-adapters/async-control-flow.mjs";

const equalityMatchers = new Set(["toBe", "toEqual", "toStrictEqual"]);
const testBlockNames = new Set(["it", "test", "xit", "xtest", "fit"]);
const testFilenamePattern =
  /(?:(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\])|[.](?:test|spec)[.][cm]?[jt]sx?$)/u;

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (node?.type !== "MemberExpression") return "";
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.property.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : "";
}

function isTestBlockCallee(node) {
  if (node?.type === "Identifier") return testBlockNames.has(node.name);
  if (node?.type === "MemberExpression") {
    return isTestBlockCallee(node.object);
  }
  return node?.type === "CallExpression" && isTestBlockCallee(node.callee);
}

function isInsideTestBlock(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) {
      return (
        current.parent?.type === "CallExpression" &&
        isTestBlockCallee(current.parent.callee)
      );
    }
    current = current.parent;
  }
  return false;
}

function loopBinding(node) {
  if (
    node.left?.type !== "VariableDeclaration" ||
    node.left.declarations.length !== 1
  ) {
    return null;
  }
  const binding = node.left.declarations[0]?.id;
  return binding?.type === "Identifier" ? binding.name : null;
}

function hasLiteralKeys(node) {
  const source = unwrapExpression(node.right);
  return (
    source?.type === "ArrayExpression" &&
    source.elements.length >= 2 &&
    source.elements.every(
      (element) =>
        element?.type === "Literal" &&
        (typeof element.value === "string" ||
          typeof element.value === "number"),
    )
  );
}

function functionReturnExpression(node) {
  if (node.body.type !== "BlockStatement") return node.body;
  if (
    node.body.body.length !== 1 ||
    node.body.body[0]?.type !== "ReturnStatement"
  ) {
    return null;
  }
  return node.body.body[0].argument;
}

function isProjectionGuard(node, parameterName) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "CallExpression" &&
    expression.callee.type === "MemberExpression" &&
    expression.callee.object.type === "Identifier" &&
    expression.callee.object.name === "Array" &&
    propertyName(expression.callee) === "isArray" &&
    expression.arguments.length === 1 &&
    unwrapExpression(expression.arguments[0])?.type === "Identifier" &&
    unwrapExpression(expression.arguments[0]).name === parameterName
  );
}

function isProjection(node, parameterName) {
  const expression = unwrapExpression(node);
  if (expression?.type === "Identifier") {
    return expression.name === parameterName;
  }
  if (expression?.type === "MemberExpression") {
    return isProjection(expression.object, parameterName);
  }
  return (
    expression?.type === "ConditionalExpression" &&
    isProjectionGuard(expression.test, parameterName) &&
    isProjection(expression.consequent, parameterName) &&
    isProjection(expression.alternate, parameterName)
  );
}

function localFunction(node, sourceCode) {
  const callee = unwrapExpression(node.callee);
  if (callee?.type !== "Identifier") return null;
  const definition = findVariable(sourceCode, callee)?.defs?.[0];
  if (definition?.type === "FunctionName") return definition.node;
  if (
    definition?.type === "Variable" &&
    (definition.node?.init?.type === "ArrowFunctionExpression" ||
      definition.node?.init?.type === "FunctionExpression")
  ) {
    return definition.node.init;
  }
  return null;
}

function transparentArgument(node, sourceCode) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 1) {
    return null;
  }
  const fn = localFunction(node, sourceCode);
  const parameter = fn?.params?.[0];
  const returned = fn ? functionReturnExpression(fn) : null;
  return parameter?.type === "Identifier" &&
    fn.params.length === 1 &&
    returned &&
    isProjection(returned, parameter.name)
    ? node.arguments[0]
    : null;
}

function rootIdentifier(node) {
  let current = unwrapExpression(node);
  while (current?.type === "MemberExpression") {
    current = unwrapExpression(current.object);
  }
  return current?.type === "Identifier" ? current : null;
}

function isConstBinding(identifier, sourceCode) {
  const definition = findVariable(sourceCode, identifier)?.defs?.[0];
  return (
    definition?.type === "Variable" &&
    definition.node?.type === "VariableDeclarator" &&
    definition.parent?.kind === "const" &&
    Boolean(definition.node.init)
  );
}

function indexedPropertyRoot(node, bindingName, sourceCode) {
  const expression = unwrapExpression(node);
  const projected = transparentArgument(expression, sourceCode);
  if (projected) {
    return indexedPropertyRoot(projected, bindingName, sourceCode);
  }
  if (
    expression?.type !== "MemberExpression" ||
    !expression.computed ||
    unwrapExpression(expression.property)?.type !== "Identifier" ||
    unwrapExpression(expression.property).name !== bindingName
  ) {
    return null;
  }
  return rootIdentifier(expression.object);
}

function assertionSubject(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    !equalityMatchers.has(propertyName(node.callee)) ||
    node.arguments.length !== 1 ||
    node.arguments[0]?.type !== "Literal"
  ) {
    return null;
  }
  const expectCall = unwrapExpression(node.callee.object);
  return expectCall?.type === "CallExpression" &&
    expectCall.callee.type === "Identifier" &&
    expectCall.callee.name === "expect" &&
    expectCall.arguments.length === 1
    ? expectCall.arguments[0]
    : null;
}

function isNode(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.type === "string"
  );
}

function containsStaticAssertion(root, bindingName, sourceCode) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const subject = node.type === "CallExpression" ? assertionSubject(node) : null;
    const object = subject
      ? indexedPropertyRoot(subject, bindingName, sourceCode)
      : null;
    if (object && isConstBinding(object, sourceCode)) return true;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) stack.push(child);
      }
    }
  }
  return false;
}

function contextFilename(context) {
  return typeof context.getFilename === "function"
    ? context.getFilename()
    : (context.filename ?? "");
}

export default function ruleNoStaticPropertyLoop() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow tests that loop over hardcoded keys to restate one precomputed object's static shape",
      },
      schema: [],
      messages: {
        staticPropertyEcho:
          "This loop restates hardcoded properties of one precomputed object. Exercise behavior for each case or assert a generated/public artifact instead.",
      },
    },
    create(context) {
      if (!testFilenamePattern.test(contextFilename(context))) return {};
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      return {
        ForOfStatement(node) {
          const bindingName = loopBinding(node);
          if (
            bindingName &&
            isInsideTestBlock(node) &&
            hasLiteralKeys(node) &&
            containsStaticAssertion(node.body, bindingName, sourceCode)
          ) {
            context.report({ node, messageId: "staticPropertyEcho" });
          }
        },
      };
    },
  };
}
