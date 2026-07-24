import {
  checkedTargetProperties,
  functionParameterByName,
  hasValidatorDelegation,
  isBroadPredicateInputType,
  isPredicateObjectContract,
  requiredTypeProps,
  typePredicateParts,
} from "../../semantic-adapters/broad-input.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

export function ruleNoUndercheckedTypePredicate() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow broad-input type predicates that assert object contracts without decisive runtime checks.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-underchecked-type-predicate",
        );
      }
      const checker = services.program.getTypeChecker();
      function check(fn) {
        const parts = typePredicateParts(fn);
        if (!parts) {
          return;
        }
        const param = functionParameterByName(fn, parts.paramName);
        const tsParam = param && services.esTreeNodeToTSNodeMap.get(param);
        const tsTargetTypeNode = services.esTreeNodeToTSNodeMap.get(
          parts.targetTypeNode,
        );
        if (!tsParam || !tsTargetTypeNode) {
          return;
        }
        const paramType = checker.getTypeAtLocation(tsParam);
        if (!isBroadPredicateInputType(checker, paramType)) {
          return;
        }
        const targetType = checker.getTypeFromTypeNode(tsTargetTypeNode);
        if (
          checker.isArrayType(targetType) ||
          checker.isTupleType(targetType)
        ) {
          return;
        }
        if (!isPredicateObjectContract(targetType)) {
          return;
        }
        const targetProps = requiredTypeProps(checker, targetType);
        if (targetProps.size === 0) {
          return;
        }
        if (
          hasValidatorDelegation(fn.body, parts.paramName, services, checker)
        ) {
          return;
        }
        const checked = checkedTargetProperties(
          fn.body,
          parts.paramName,
          targetProps,
        );
        if ([...targetProps].every((prop) => checked.has(prop))) {
          return;
        }
        context.report({
          node: fn.returnType,
          message:
            "Do not narrow broad input with an under-checked type predicate. Check the asserted fields or delegate to an owned schema/validator.",
        });
      }
      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
      };
    },
  };
}
