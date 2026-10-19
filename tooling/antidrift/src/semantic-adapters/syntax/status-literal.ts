import { fieldOf, isSyntaxNode } from "../kernel/syntax-node.ts";
import type { Rule } from "eslint";
import { canonicalStatusLiteralOwner } from "../shape/status-literal.ts";

function fileMatchesPath(filename: string, filePath: string) {
  return filename.replace(/\\/gu, "/").endsWith(filePath.replace(/\\/gu, "/"));
}
export const ruleNoStatusLiteralInType = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow re-declaring canonical domain status values as type literals outside the owning module (domain registry).",
    },
    schema: [
      {
        type: "object",
        properties: { statuses: { type: "object" } },
        additionalProperties: false,
      },
    ],
  },
  create(context: Rule.RuleContext) {
    const option: unknown = context.options[0];
    const statuses = fieldOf(option, "statuses") ?? {};
    if (Object.keys(statuses).length === 0) {
      return {};
    }
    const filename = context.filename;
    return {
      TSLiteralType(node: unknown) {
        const owner = canonicalStatusLiteralOwner(node, statuses);
        if (!owner) {
          return;
        }
        if (!isSyntaxNode(node)) {
          throw new TypeError("Status literal has no syntax node");
        }
        if (fileMatchesPath(filename, owner.owner)) {
          return;
        }
        context.report({
          node,
          message: `String literal '${owner.value}' duplicates a canonical status from ${owner.owner}. Import the type instead.`,
        });
      },
    };
  },
} satisfies Rule.RuleModule;
