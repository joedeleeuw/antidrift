import {
  isRuleFile,
  scopeProperties,
} from "../../oxlint-plugin/portable/scope.js";
import { verifyHop } from "./hop-inline-verification.js";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

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

function delegatedCall(node, identifier) {
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
  let call = node.body;
  if (call.type === "BlockStatement") {
    if (call.body.length !== 1) {
      return null;
    }
    const statement = call.body[0];
    if (statement.type === "ReturnStatement") {
      call = statement.argument;
    } else if (statement.type === "ExpressionStatement") {
      call = statement.expression;
    } else {
      return null;
    }
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
  const call = delegatedCall(node, identifier);
  if (!call) {
    return null;
  }
  const nodes = services.esTreeNodeToTSNodeMap;
  return {
    declaration: nodes.get(
      node.type === "FunctionDeclaration" ? node : identifier.parent
    ),
    functionNode: nodes.get(node),
    nameNode: nodes.get(identifier),
    call: nodes.get(call),
    callee: call.callee,
  };
}

export default {
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
  create(context) {
    if (!isRuleFile(context)) {
      return {};
    }
    const services = requireTypeServices(context);
    if (!services) {
      return missingTypeServicesVisitors(context, "no-wrapping-functions");
    }
    return namedFunctionVisitors((node, identifier) => {
      const candidate = hopCandidate(services, node, identifier);
      if (!candidate) {
        return;
      }
      let verdict;
      try {
        verdict = verifyHop(services.program, candidate);
      } catch (error) {
        verdict = { incomplete: `the analysis failed with ${error}` };
      }
      const hopNames = {
        name: identifier.name,
        callee: context.sourceCode.getText(candidate.callee),
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
};
