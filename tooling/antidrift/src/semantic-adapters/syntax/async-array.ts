import { fieldOf, isSyntaxNode } from "../kernel/syntax-node.ts";
import type { Rule } from "eslint";
import {
  asyncArrayCallbackClassification,
  isDirectlyWrappedInPromiseCombinator,
  isReturnedExpression,
  markAwaitedPendingMaps,
  markReturnedPendingMaps,
  queuePendingAsyncMap,
} from "../kernel/async-control-flow.ts";
import type { PendingAsyncMap } from "../kernel/async-control-flow.ts";

function asyncMapMessage(method: string) {
  return `Wrap .${method}() with an async callback in Promise.all(...) (or Promise.allSettled) so the promises are awaited.`;
}
function enabledAsyncArrayBranches(option: unknown) {
  const branches = fieldOf(option, "branches");
  if (branches === undefined) {
    return new Set(["never-await"]);
  }
  if (!Array.isArray(branches)) {
    throw new TypeError("async-array branches must be an array");
  }
  const candidates: readonly unknown[] = branches;
  const names = candidates.filter((branch) => typeof branch === "string");
  if (names.length !== candidates.length) {
    throw new TypeError("async-array branches must be strings");
  }
  return new Set(["never-await", ...names]);
}
export const ruleNoAsyncArrayMethod = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow async callbacks passed to array iteration methods that silently drop or mishandle the returned promises.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          branches: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              enum: ["never-await", "requires-collection"],
            },
          },
        },
      },
    ],
  },
  create(context: Rule.RuleContext): Rule.RuleListener {
    const sourceCode = context.sourceCode;
    const pendingAsyncMaps: PendingAsyncMap[] = [];
    const enabledBranches = enabledAsyncArrayBranches(context.options[0]);
    return {
      "Program:exit"() {
        for (const pending of pendingAsyncMaps) {
          if (!pending.awaited && !pending.returned) {
            if (!isSyntaxNode(pending.node)) {
              throw new TypeError("Pending async map has no syntax node");
            }
            context.report({
              node: pending.node,
              message: asyncMapMessage(pending.method),
            });
          }
        }
      },
      ReturnStatement(node) {
        markReturnedPendingMaps(sourceCode, node.argument, pendingAsyncMaps);
      },
      CallExpression(node) {
        markAwaitedPendingMaps(sourceCode, node, pendingAsyncMaps);
        const classification = asyncArrayCallbackClassification(node);
        if (!classification) {
          return;
        }
        const { callback, method } = classification;
        if (!enabledBranches.has(classification.kind)) {
          return;
        }
        if (classification.kind === "never-await") {
          context.report({
            node: callback,
            message: `.${method}() does not await its callback, so an async callback here runs unhandled. Use a for...of loop.`,
          });
          return;
        }

        if (isDirectlyWrappedInPromiseCombinator(node)) {
          return;
        }
        if (isReturnedExpression(node)) {
          return;
        }
        if (
          queuePendingAsyncMap(
            sourceCode,
            node,
            callback,
            method,
            pendingAsyncMaps
          )
        ) {
          return;
        }
        context.report({
          node: callback,
          message: asyncMapMessage(method),
        });
      },
    };
  },
} satisfies Rule.RuleModule;
