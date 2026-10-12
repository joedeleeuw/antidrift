import {
  checkedPropertyPaths,
  claimedTargetVariants,
  checkedTargetProperties,
  functionParameterByName,
  hasValidatorDelegation,
  isBroadPredicateInputType,
  isPredicateObjectContract,
  predicateContractEvidence,
  requiredTypeProps,
  typePredicateParts,
} from "../../semantic-adapters/broad-input.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

function isObjectContract(checker, type) {
  return (
    isPredicateObjectContract(type) &&
    !checker.isArrayType(type) &&
    !checker.isTupleType(type)
  );
}

// A body that reads into a required object field claims that field's shape,
// so it must check the field's own required properties too.
function uncheckedProbedPayload(checker, variants, paths) {
  for (const variant of variants) {
    for (const property of checker.getPropertiesOfType(variant)) {
      const prefix = `${property.name}.`;
      if (![...paths].some((path) => path.startsWith(prefix))) continue;
      const payloadType = checker.getNonNullableType(
        checker.getTypeOfSymbol(property)
      );
      if (!isObjectContract(checker, payloadType)) continue;
      for (const nested of requiredTypeProps(checker, payloadType)) {
        if (!paths.has(`${prefix}${nested}`)) return true;
      }
    }
  }
  return false;
}

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
          "no-underchecked-type-predicate"
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
          parts.targetTypeNode
        );
        if (!tsParam || !tsTargetTypeNode) {
          return;
        }
        const paramType = checker.getTypeAtLocation(tsParam);
        // An unresolved declared type (TypeScript's error type) is a broken
        // import or global, not raw input the predicate has to validate.
        if (
          paramType.intrinsicName === "error" ||
          !isBroadPredicateInputType(checker, paramType)
        ) {
          return;
        }
        const targetType = checker.getTypeFromTypeNode(tsTargetTypeNode);
        // The object variants the predicate asserts: the target itself, or
        // every member of a union of object contracts.
        const variants = targetType.isUnion() ? targetType.types : [targetType];
        if (!variants.every((variant) => isObjectContract(checker, variant))) {
          return;
        }
        // Of a union, only the variants the body's literal tag comparisons
        // can still accept are claimed.
        const claimed = claimedTargetVariants(
          fn.body,
          parts.paramName,
          variants,
          services,
          checker
        );
        const targetProps = new Set(
          claimed.flatMap((variant) => [...requiredTypeProps(checker, variant)])
        );
        if (targetProps.size === 0) {
          return;
        }
        if (
          hasValidatorDelegation(fn.body, parts.paramName, services, checker)
        ) {
          return;
        }
        const evidence = predicateContractEvidence(
          fn.body,
          parts.paramName,
          targetType,
          services,
          checker
        );
        if (evidence.proven) {
          return;
        }
        const checked = checkedTargetProperties(
          fn.body,
          parts.paramName,
          targetProps
        );
        if (
          [...targetProps].every(
            (prop) => checked.has(prop) || evidence.checked.has(prop)
          ) &&
          !uncheckedProbedPayload(
            checker,
            variants,
            checkedPropertyPaths(fn.body, parts.paramName)
          )
        ) {
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
