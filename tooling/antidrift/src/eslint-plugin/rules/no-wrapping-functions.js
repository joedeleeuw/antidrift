import { scopeProperties } from "../../semantic-adapters/kernel/rule-scope.ts";
import { verifyHop } from "../../semantic-adapters/callgraph/hop-inline-verification.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

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

function isParameterPropertyRead(node, parameterNames) {
  if (node?.type !== "MemberExpression" || node.optional) return false;
  let current = node;
  while (current.type === "MemberExpression") {
    if (current.optional) return false;
    current = current.object;
  }
  return current.type === "Identifier" && parameterNames.has(current.name);
}

function isDefaultFallback(node) {
  if (!node) return true;
  if (node.type === "Literal") return true;
  if (node.type === "ObjectExpression") {
    return node.properties.every(
      (property) =>
        property.type === "Property" && isDefaultFallback(property.value)
    );
  }
  if (node.type === "ArrayExpression") {
    return node.elements.every(isDefaultFallback);
  }
  if (node.type === "Identifier") return node.name === "undefined";
  return node.type === "UnaryExpression" && node.operator === "void";
}

function isPropertyHopBody(node, parameterNames) {
  if (isParameterPropertyRead(node, parameterNames)) return true;
  return (
    node?.type === "LogicalExpression" &&
    (node.operator === "??" || node.operator === "||") &&
    isParameterPropertyRead(node.left, parameterNames) &&
    isDefaultFallback(node.right)
  );
}

function delegatedBody(node, identifier) {
  if (
    !identifier ||
    node.async ||
    node.generator ||
    node.typeParameters ||
    node.returnType?.typeAnnotation.type === "TSTypePredicate" ||
    node.params.some(
      (parameter) =>
        parameter.type !== "Identifier" && parameter.type !== "RestElement"
    )
  ) {
    return null;
  }
  const parameterNames = new Set(
    node.params.map((parameter) =>
      parameter.type === "Identifier" ? parameter.name : parameter.argument.name
    )
  );
  let body = node.body;
  let allowsPropertyRead = true;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1) {
      return null;
    }
    const statement = body.body[0];
    if (statement.type === "ReturnStatement") {
      body = statement.argument;
    } else if (statement.type === "ExpressionStatement") {
      body = statement.expression;
      allowsPropertyRead = false;
    } else {
      return null;
    }
  }
  if (
    body &&
    isComposedCall(body) &&
    (body.callee.type !== "Identifier" || body.callee.name !== identifier.name)
  ) {
    return body;
  }
  return allowsPropertyRead && isPropertyHopBody(body, parameterNames)
    ? body
    : null;
}

function namedFunctionVisitors(visit) {
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

function hopCandidate(services, node, identifier) {
  const body = delegatedBody(node, identifier);
  if (!body) {
    return null;
  }
  const nodes = services.esTreeNodeToTSNodeMap;
  return {
    declaration: nodes.get(
      node.type === "FunctionDeclaration" ? node : identifier.parent
    ),
    functionNode: nodes.get(node),
    nameNode: nodes.get(identifier),
    body: nodes.get(body),
    operation: body.type === "CallExpression" ? body.callee : body,
  };
}

export default defineTypeScriptRule({
  ruleName: "no-wrapping-functions",
  skipGenerated: false,
  skipNonRuleFile: true,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow named functions whose inlining at every call site the TypeScript program verifies.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      hop: "'{{name}}' is a hop to '{{callee}}': inlining it at its {{calls}} call site(s) type-checks and keeps each call's type, bindings and evaluation order. Call the owner directly and delete '{{name}}'.",
      unusedHop:
        "'{{name}}' is a hop to '{{callee}}' with no call site; deleting it type-checks. Delete '{{name}}'.",
      incomplete:
        "Incomplete analysis for '{{name}}', a candidate hop to '{{callee}}': {{cause}}.",
    },
  },
  visitors({ context, program, services }) {
    return namedFunctionVisitors((node, identifier) => {
      const candidate = hopCandidate(services, node, identifier);
      if (!candidate) {
        return;
      }
      let verdict;
      try {
        verdict = verifyHop(program, candidate);
      } catch (error) {
        verdict = { incomplete: `the analysis failed with ${error}` };
      }
      const hopNames = {
        name: identifier.name,
        callee: context.sourceCode.getText(candidate.operation),
      };
      if (verdict.incomplete) {
        context.report({
          node: identifier,
          messageId: "incomplete",
          data: { ...hopNames, cause: verdict.incomplete },
        });
      } else if (verdict.hop) {
        context.report({
          node: identifier,
          messageId: verdict.calls === 0 ? "unusedHop" : "hop",
          data: { ...hopNames, calls: verdict.calls },
        });
      }
    });
  },
});
