// Rule ported from getsentry/sentry static/eslint/eslintPluginSentry
// (no-query-data-type-parameters). See that repo's LICENSE.
const QUERY_DATA_METHODS = new Set(["getQueryData", "setQueryData"]);

export default function ruleNoQueryDataTypeParameters() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow explicit type parameters on queryClient.getQueryData and queryClient.setQueryData; they override key-based inference and mask type mismatches",
      },
      schema: [],
      messages: {
        noTypeParameters:
          "Do not pass explicit type parameters to {{method}}. Use queryOptions — it infers the correct type from the query key.",
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (!node.typeArguments || node.typeArguments.params.length === 0) {
            return;
          }
          const { callee } = node;
          if (
            callee.type !== "MemberExpression" ||
            callee.property.type !== "Identifier"
          ) {
            return;
          }
          const method = callee.property.name;
          if (!QUERY_DATA_METHODS.has(method)) return;
          context.report({
            node: node.typeArguments,
            messageId: "noTypeParameters",
            data: { method },
          });
        },
      };
    },
  };
}
