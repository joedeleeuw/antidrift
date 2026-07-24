import { isUnsafeJsonParseInput } from "../../semantic-adapters/parse-input.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

export function ruleNoUnsafeDeserialize() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow JSON.parse on any/unknown values without validation.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-unsafe-deserialize");
      }
      const checker = services.program.getTypeChecker();
      return {
        CallExpression(node) {
          if (isUnsafeJsonParseInput(node, services, checker)) {
            context.report({
              node,
              message:
                "Do not JSON.parse any/unknown input directly. Validate through a schema boundary instead.",
            });
          }
        },
      };
    },
  };
}
