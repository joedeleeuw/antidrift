import { isRuleFile, scopeProperties } from "./scope.js";

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          failureFunctions: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      exhaustive:
        "Terminate this unreachable branch with a throw or the configured exhaustive-failure owner; a never annotation has no runtime effect.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const failures = new Set(context.options[0]?.failureFunctions ?? []);
    return {
      VariableDeclarator(node) {
        if (node.id.typeAnnotation?.typeAnnotation?.type !== "TSNeverKeyword") {
          return;
        }
        const declaration = node.parent;
        const statements =
          declaration.parent?.body ?? declaration.parent?.consequent;
        if (!Array.isArray(statements)) return;
        const tail = statements.slice(statements.indexOf(declaration) + 1);
        if (tail.some((statement) => statement.type === "ThrowStatement")) {
          return;
        }
        if (
          tail.some((statement) => {
            const expression = statement.argument ?? statement.expression;
            return (
              expression?.type === "CallExpression" &&
              expression.callee.type === "Identifier" &&
              failures.has(expression.callee.name)
            );
          })
        ) {
          return;
        }
        context.report({ node, messageId: "exhaustive" });
      },
    };
  },
};
