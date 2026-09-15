import { isRuleFile, scopeProperties } from "./scope.js";

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      runtime:
        "Keep shared code runtime independent; move Bun APIs into the runtime adapter owner.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    if (
      !context.options[0]?.files &&
      !/(?:^|\/)shared\//u.test(context.filename)
    ) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        if (/^bun(?::|$)/u.test(node.source.value)) {
          context.report({ node, messageId: "runtime" });
        }
      },
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "Bun") {
          return;
        }
        let scope = context.sourceCode.getScope(node);
        while (scope) {
          if (scope.set.get("Bun")?.defs.length) return;
          scope = scope.upper;
        }
        context.report({ node, messageId: "runtime" });
      },
    };
  },
};
