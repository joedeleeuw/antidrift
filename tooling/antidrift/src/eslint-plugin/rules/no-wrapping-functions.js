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

export function hopCandidate(services, node, identifier) {
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
      hop: "'{{name}}' is a hop to '{{callee}}': inlining it at its {{calls}} call site(s) type-checks and keeps each call's type and bindings. Call the owner directly and delete '{{name}}'.",
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
      if (!verdict.hop) return;
      context.report({
        node: identifier,
        messageId: "hop",
        data: {
          name: identifier.name,
          callee: context.sourceCode.getText(candidate.callee),
          calls: verdict.calls,
        },
      });
    });
  },
};
