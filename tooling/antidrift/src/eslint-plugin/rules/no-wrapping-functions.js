import {
  delegatedCall,
  namedFunctionVisitors,
} from "../../oxlint-plugin/portable/no-wrapping-functions.js";
import {
  isRuleFile,
  scopeProperties,
} from "../../oxlint-plugin/portable/scope.js";
import { verifyHop } from "./hop-inline-verification.js";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

function hopCandidate(services, node, identifier) {
  const call = delegatedCall(node, identifier);
  if (!call) return null;
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
        "Incomplete analysis: '{{name}}' would be a verified hop to '{{callee}}', but its export cannot be checked against the package's public surface because {{cause}}.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const services = requireTypeServices(context);
    if (!services) {
      return missingTypeServicesVisitors(context, "no-wrapping-functions");
    }
    return namedFunctionVisitors((node, identifier) => {
      const candidate = hopCandidate(services, node, identifier);
      if (!candidate) return;
      const verdict = verifyHop(services.program, candidate);
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
