import { hasNullablePositionalTuple } from "../../semantic-adapters/tuple-shape.mjs";

export function ruleNoNullablePositionalTuple() {
  return {
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow tuple types that model multiple nullable positional slots.",
      },
      schema: [],
    },
    create(context) {
      const services =
        context.sourceCode?.parserServices ?? context.parserServices;
      const checker = services?.program?.getTypeChecker?.();
      return {
        TSTupleType(node) {
          if (!hasNullablePositionalTuple(node, services, checker)) {
            return;
          }
          context.report({
            node,
            message:
              "Do not model multi-field nullable state as a positional tuple. Use a named object or explicit state union.",
          });
        },
      };
    },
  };
}
