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

function referenceRoot(node) {
  return node.type === "MemberExpression" ? referenceRoot(node.object) : node;
}

// A hop only forwards its own inputs. An argument that is a string, number or
// regex literal, or a value the function reaches from its scope, is something
// the function owns: a format, a key, or a binding a callback needs.
function isForwardedArgument(node, parameterNames) {
  if (node.type === "SpreadElement") {
    return (
      node.argument.type === "Identifier" &&
      parameterNames.has(node.argument.name)
    );
  }
  return (
    (isReference(node) && parameterNames.has(referenceRoot(node).name)) ||
    (node.type === "Literal" && node.value === null && !node.regex) ||
    (node.type === "ObjectExpression" && node.properties.length === 0) ||
    (node.type === "ArrayExpression" && node.elements.length === 0)
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
          (param) => param.type !== "Identifier" && param.type !== "RestElement"
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
      const parameterNames = new Set(
        node.params.map((parameter) =>
          parameter.type === "RestElement"
            ? parameter.argument.name
            : parameter.name
        )
      );
      if (
        call?.type !== "CallExpression" ||
        call.optional ||
        call.typeArguments ||
        (call.callee.type === "Identifier" &&
          call.callee.name === identifier.name) ||
        !isReference(call.callee) ||
        !call.arguments.every((argument) =>
          isForwardedArgument(argument, parameterNames)
        )
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
