import { isAppeasementContractCast } from "../../semantic-adapters/broad-input.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

export function ruleNoAppeasementCast() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow casting any/unknown values into named object contracts.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-appeasement-cast");
      }
      const checker = services.program.getTypeChecker();
      return {
        TSAsExpression(node) {
          if (!isAppeasementContractCast(node, services, checker)) {
            return;
          }
          context.report({
            node,
            message:
              "Do not cast any/unknown into a named contract. Validate or narrow the value before assigning the type.",
          });
        },
      };
    },
  };
}
