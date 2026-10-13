import ts from "typescript";
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
      const checker = services.program.getTypeChecker();
      const model = boundaryModel(services.program);
      const reported = new Set();
      function check(node, expression, target) {
        if (reported.has(node) || !model.unchecked(expression, target).length) {
          return;
        }
        reported.add(node);
        context.report({ node, messageId: "decodeUnknown" });
      }
      function assertion(node) {
        const expression = services.esTreeNodeToTSNodeMap.get(node);
        check(
          node,
          expression.expression,
          checker.getTypeAtLocation(expression)
        );
      }
      return {
        TSAsExpression: assertion,
        TSTypeAssertion: assertion,
        VariableDeclarator(node) {
          const declaration = services.esTreeNodeToTSNodeMap.get(node);
          if (declaration.type && declaration.initializer) {
            check(
              node,
              declaration.initializer,
              checker.getTypeFromTypeNode(declaration.type)
            );
          }
        },
        AssignmentExpression(node) {
          const assignment = services.esTreeNodeToTSNodeMap.get(node);
          check(
            node,
            assignment.right,
            checker.getTypeAtLocation(assignment.left)
          );
        },
        CallExpression(node) {
          const call = services.esTreeNodeToTSNodeMap.get(node);
          const signature = checker.getResolvedSignature(call);
          if (!signature || model.decode(call)) return;
          for (const [index, argument] of call.arguments.entries()) {
            const parameter = signature.parameters[index];
            if (parameter) {
              check(
                node.arguments[index],
                argument,
                checker.getTypeOfSymbolAtLocation(parameter, call)
              );
            }
          }
        },
        ReturnStatement(node) {
          if (!node.argument) return;
          const statement = services.esTreeNodeToTSNodeMap.get(node);
          let owner = statement.parent;
          while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
          if (!owner?.type) return;
          check(
            node,
            statement.expression,
            checker.getAwaitedType(checker.getTypeFromTypeNode(owner.type))
          );
        },
      };
    },
  };
}
