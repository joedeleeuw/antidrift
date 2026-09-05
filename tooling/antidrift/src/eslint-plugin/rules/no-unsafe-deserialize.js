import { isUnsafeJsonParseInput } from "../../semantic-adapters/parse-input.mjs";
import { parsedJsonTarget } from "../../semantic-adapters/parsed-json.mjs";
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
          "Require string input and schema validation before parsed JSON enters a domain contract.",
      },
      schema: [],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(context, "no-unsafe-deserialize");
      }
      const checker = services.program.getTypeChecker();
      function inspectTarget(node) {
        const target = parsedJsonTarget(node, context, services, checker);
        if (!target) return false;
        context.report({
          node,
          message: `Validate parsed JSON against the schema for '${target}' before assigning that contract. JSON.parse validates syntax, not domain values.`,
        });
        return true;
      }
      return {
        CallExpression(node) {
          if (inspectTarget(node)) return;
          if (isUnsafeJsonParseInput(node, services, checker)) {
            context.report({
              node,
              message:
                "Do not JSON.parse any/unknown input directly. Validate through a schema boundary instead.",
            });
          }
        },
        Identifier: inspectTarget,
      };
    },
  };
}
