import { isRuleFile, scopeProperties } from "./scope.js";
import { isIdentifier } from "./ast.js";

export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      noEnterWith:
        "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient " +
        "async context frame with no restore point, so background work " +
        "that resumes there adopts the store. Scope it with run(...) at " +
        "the boundary instead (see request-scope.ts).",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          !isIdentifier(callee.property, "enterWith")
        ) {
          return;
        }
        context.report({ node, messageId: "noEnterWith" });
      },
    };
  },
};
