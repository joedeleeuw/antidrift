import { boundaryModel } from "../../semantic-adapters/boundary-model.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

export default function ruleUnknownInputMustBeDecoded() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require decoding before untrusted input reaches a cast or typed use.",
      },
      schema: [],
      messages: {
        decodeUnknown:
          "Untrusted input reaches a typed use without a dominating decode. Decode it at the receiving boundary.",
        incompleteAnalysis:
          "Untrusted input provenance could not be resolved ({{cause}}). Decode the value before typed use.",
      },
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "unknown-input-must-be-decoded"
        );
      }
      const model = boundaryModel(services.program);
      const reported = new Set();
      function reportRoots(node, roots) {
        if (reported.has(node) || !roots.length) return;
        reported.add(node);
        if (roots.some((root) => !root.incomplete)) {
          context.report({ node, messageId: "decodeUnknown" });
          return;
        }
        context.report({
          node,
          messageId: "incompleteAnalysis",
          data: { cause: roots[0].incomplete },
        });
      }
      const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);
      function sink(node) {
        reportRoots(node, model.uncheckedAt(tsNode(node)));
      }
      function callArguments(node) {
        for (const argument of node.arguments) {
          reportRoots(argument, model.uncheckedArgument(tsNode(argument)));
        }
      }
      return {
        TSAsExpression: sink,
        TSTypeAssertion: sink,
        VariableDeclarator: sink,
        AssignmentExpression: sink,
        ReturnStatement: sink,
        CallExpression(node) {
          reportRoots(node, model.uncheckedAt(tsNode(node)));
          for (const argument of node.arguments) {
            reportRoots(argument, model.uncheckedArgument(tsNode(argument)));
          }
        },
        NewExpression: callArguments,
      };
    },
  };
}
