import { isRuleFile, scopeProperties } from "./scope.js";

function isReference(node) {
  return (
    node.type === "Identifier" ||
    (node.type === "MemberExpression" &&
      !node.optional &&
      !node.computed &&
      isReference(node.object))
  );
}

function isForwardedArgument(node) {
  return (
    isReference(node) ||
    node.type === "Literal" ||
    (node.type === "ObjectExpression" && node.properties.length === 0) ||
    (node.type === "ArrayExpression" && node.elements.length === 0) ||
    (node.type === "SpreadElement" && node.argument.type === "Identifier")
  );
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

    function check(node, identifier) {
      if (
        !identifier ||
        node.async ||
        node.generator ||
        node.typeParameters ||
        node.returnType?.typeAnnotation.type === "TSTypePredicate" ||
        node.params.some(
          (param) =>
            param.type !== "Identifier" && param.type !== "RestElement",
        )
      ) {
        return;
      }
      let call = node.body;
      if (call.type === "BlockStatement") {
        if (call.body.length !== 1) return;
        const statement = call.body[0];
        if (statement.type === "ReturnStatement") {
          call = statement.argument;
        } else if (statement.type === "ExpressionStatement") {
          call = statement.expression;
        } else return;
      }
      if (
        call?.type !== "CallExpression" ||
        call.optional ||
        call.typeArguments ||
        (call.callee.type === "Identifier" &&
          call.callee.name === identifier.name) ||
        !isReference(call.callee) ||
        !call.arguments.every(isForwardedArgument)
      ) {
        return;
      }
      context.report({
        node: identifier,
        messageId: "wrapper",
        data: {
          name: identifier.name,
          callee: context.sourceCode.getText(call.callee),
        },
      });
    }

    return {
      FunctionDeclaration(node) {
        check(node, node.id);
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          (node.init?.type === "ArrowFunctionExpression" ||
            node.init?.type === "FunctionExpression")
        ) {
          check(node.init, node.id);
        }
      },
    };
  },
};
