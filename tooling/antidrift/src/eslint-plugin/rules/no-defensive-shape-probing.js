import {
  countShapeProbesIn,
  hasBroadObjectEntriesValue,
  objectEntriesCallbackProbe,
} from "../../semantic-adapters/broad-input.mjs";
import {
  missingTypeServicesVisitors,
  requireTypeServices,
} from "./type-services.js";

function isTypePredicateReturn(fn) {
  return fn?.returnType?.typeAnnotation?.type === "TSTypePredicate";
}
export function ruleNoDefensiveShapeProbing() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Object.entries normalizers that repeatedly probe broad object shape.",
      },
      schema: [
        {
          type: "object",
          properties: { threshold: { type: "number" } },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const services = requireTypeServices(context);
      if (!services) {
        return missingTypeServicesVisitors(
          context,
          "no-defensive-shape-probing",
        );
      }
      const checker = services.program.getTypeChecker();
      const threshold = context.options[0]?.threshold ?? 4;
      return {
        CallExpression(node) {
          const probe = objectEntriesCallbackProbe(node);
          if (!probe || isTypePredicateReturn(probe.callback)) {
            return;
          }
          if (!hasBroadObjectEntriesValue(probe, services, checker)) {
            return;
          }
          if (
            countShapeProbesIn(probe.callback.body, probe.paramNames) <
            threshold
          ) {
            return;
          }
          context.report({
            node: probe.callback,
            message:
              "Do not unpack broad object shapes by probing property names inside Object.entries(...). Move the normalization to an owned schema or converter.",
          });
        },
      };
    },
  };
}
