import { isUnsafeJsonParseInput } from "../../semantic-adapters/parse-input.mjs";
import { parsedJsonTarget } from "../../semantic-adapters/parsed-json.mjs";
import { defineTypeScriptRule } from "../../semantic-adapters/ts-rule-kernel.mjs";

export function ruleNoUnsafeDeserialize() {
  return defineTypeScriptRule({
    ruleName: "no-unsafe-deserialize",
    skipGenerated: false,
    meta: {
      type: "problem",
      docs: {
        description:
          "Require string input and schema validation before parsed JSON enters a domain contract.",
      },
      schema: [],
    },
    visitors({ context, checker, services }) {
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
  });
}
