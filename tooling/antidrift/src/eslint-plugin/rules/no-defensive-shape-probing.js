import {
  countShapeProbesIn,
  hasBroadObjectEntriesBinding,
  objectEntriesCallbackProbe,
} from "../../semantic-adapters/boundary/broad-input.ts";
import { defineTypeScriptRule } from "../../semantic-adapters/kernel/rule-kernel.ts";

function isTypePredicateReturn(fn) {
  return fn?.returnType?.typeAnnotation?.type === "TSTypePredicate";
}
export function ruleNoDefensiveShapeProbing() {
  return defineTypeScriptRule({
    ruleName: "no-defensive-shape-probing",
    skipGenerated: false,
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
    visitors({ context, checker, services, options }) {
      const threshold = options[0]?.threshold ?? 4;
      return {
        CallExpression(node) {
          const probe = objectEntriesCallbackProbe(node);
          if (!probe || isTypePredicateReturn(probe.callback)) {
            return;
          }
          if (!hasBroadObjectEntriesBinding(probe, services, checker)) {
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
  });
}
