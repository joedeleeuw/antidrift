import { isRuleFile, scopeProperties } from "./scope.js";

function isCallee(node) {
  return (
    node.type === "Identifier" ||
    (node.type === "MemberExpression" &&
      !node.optional &&
      !node.computed &&
      (isCallee(node.object) || isComposedCall(node.object)))
  );
}

function isComposedCall(node) {
  return (
    node.type === "CallExpression" &&
    !node.optional &&
    !node.typeArguments &&
    isCallee(node.callee) &&
    node.arguments.every(isForwardedArgument)
  );
}

function isForwardedProperty(property) {
  return (
    (property.type === "SpreadElement" &&
      isForwardedArgument(property.argument)) ||
    (property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.computed &&
      isForwardedArgument(property.value))
  );
}

function isForwardedArgument(node) {
  switch (node?.type) {
    case "Identifier":
    case "MemberExpression":
      return isCallee(node);
    case "Literal":
      return true;
    case "TemplateLiteral":
      return node.expressions.every(isForwardedArgument);
    case "ObjectExpression":
      return node.properties.every(isForwardedProperty);
    case "ArrayExpression":
      return node.elements.every(isForwardedArgument);
    case "SpreadElement":
      return isForwardedArgument(node.argument);
    case "CallExpression":
      return isComposedCall(node);
    default:
      return false;
  }
}

export function delegatedCall(node, identifier) {
  if (
    !identifier ||
    node.async ||
    node.generator ||
    node.typeParameters ||
    node.returnType?.typeAnnotation.type === "TSTypePredicate" ||
    node.params.some(
      (param) => param.type !== "Identifier" && param.type !== "RestElement"
    )
  ) {
    return null;
  }
  let call = node.body;
  if (call.type === "BlockStatement") {
    if (call.body.length !== 1) return null;
    const statement = call.body[0];
    if (statement.type === "ReturnStatement") {
      call = statement.argument;
    } else if (statement.type === "ExpressionStatement") {
      call = statement.expression;
    } else return null;
  }
  if (
    !call ||
    !isComposedCall(call) ||
    (call.callee.type === "Identifier" && call.callee.name === identifier.name)
  ) {
    return null;
  }
  return call;
}

export function namedFunctionVisitors(visit) {
  return {
    FunctionDeclaration(node) {
      visit(node, node.id);
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" &&
        (node.init?.type === "ArrowFunctionExpression" ||
          node.init?.type === "FunctionExpression")
      ) {
        visit(node.init, node.id);
      }
    },
  };
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow named functions that add a delegation layer without computation.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      wrapper:
        "'{{name}}' only delegates to '{{callee}}'. Prefer calling that owner directly unless this function has a concrete boundary, policy, or callback requirement.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    return namedFunctionVisitors((node, identifier) => {
      const call = delegatedCall(node, identifier);
      if (!call) return;
      context.report({
        node: identifier,
        messageId: "wrapper",
        data: {
          name: identifier.name,
          callee: context.sourceCode.getText(call.callee),
        },
      });
    });
  },
};
