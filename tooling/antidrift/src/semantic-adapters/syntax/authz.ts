import { fieldOf, isSyntaxNode } from "../kernel/syntax-node.ts";
import type { Rule } from "eslint";
import { createAuthBoundaryTracker } from "../boundary/auth-boundary.ts";

export const ruleRequireAuthzCheck = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an authorization/ownership check when a handler reads request params.",
    },
    schema: [
      {
        type: "object",
        properties: {
          authzFunctions: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context: Rule.RuleContext) {
    const options: unknown = context.options[0];
    const configured = fieldOf(options, "authzFunctions") ?? [];
    if (!Array.isArray(configured)) {
      throw new TypeError("authzFunctions must be strings");
    }
    const candidates: readonly unknown[] = configured;
    const authzFunctions = candidates.filter(
      (name) => typeof name === "string"
    );
    if (authzFunctions.length !== candidates.length) {
      throw new TypeError("authzFunctions must be strings");
    }
    if (authzFunctions.length === 0) {
      return {};
    }
    const tracker = createAuthBoundaryTracker({
      authzFunctions,
      onFrameExit(frame) {
        if (frame.paramsAccess && !frame.sawAuthz) {
          if (!isSyntaxNode(frame.paramsAccess)) {
            throw new TypeError(
              "Authorization frame has no params syntax node"
            );
          }
          context.report({
            node: frame.paramsAccess,
            message:
              "Handler reads request params without a configured authorization/ownership check.",
          });
        }
      },
    });
    return tracker.visitors;
  },
} satisfies Rule.RuleModule;
