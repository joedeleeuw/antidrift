import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { isTypeOnlyModule } from "../../semantic-adapters/kernel/syntax-node.ts";

const DEVTOOLS_PACKAGES = new Set([
  "@tanstack/react-devtools",
  "@tanstack/react-query-devtools",
  "@tanstack/react-router-devtools",
  "@tanstack/react-table-devtools",
]);
export default {
  meta: {
    schema: [
      {
        type: "object",
        properties: {
          ...scopeProperties,
          modules: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],

    type: "problem",
    messages: {
      staticDevtoolsPackage:
        "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.",
      staticDevtoolsModule:
        "Keep devtools modules behind a dynamic import so route shells can mount before devtools code loads.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== "string" || isTypeOnlyModule(node)) {
          return;
        }
        if (DEVTOOLS_PACKAGES.has(source)) {
          context.report({ node, messageId: "staticDevtoolsPackage" });
          return;
        }
        if ((context.options[0]?.modules ?? []).includes(source)) {
          context.report({ node, messageId: "staticDevtoolsModule" });
        }
      },
    };
  },
};
