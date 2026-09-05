import { isRuleFile, scopeProperties } from "./scope.js";
import { getIdentifierName, getNode } from "./syntax.js";

export const noAsNeverRule = {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    docs: {
      description: "Disallow casting expressions to never.",
    },
    messages: {
      forbidden: "Do not cast to 'never'. Fix the type boundary instead.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      TSAsExpression(node) {
        const annotation = getNode(node, "typeAnnotation");
        if (!annotation) {
          return;
        }
        if (annotation.type === "TSNeverKeyword") {
          context.report({ node, messageId: "forbidden" });
          return;
        }
        if (annotation.type !== "TSTypeReference") {
          return;
        }
        const typeName = getNode(annotation, "typeName");
        if (getIdentifierName(typeName) !== "never") {
          return;
        }
        context.report({ node, messageId: "forbidden" });
      },
    };
  },
};
export default noAsNeverRule;
