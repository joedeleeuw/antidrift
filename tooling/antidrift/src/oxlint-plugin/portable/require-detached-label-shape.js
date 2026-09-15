import { isRuleFile, scopeProperties } from "./scope.js";
import { isStringLiteral } from "./ast.js";

const KEBAB_WORD = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const LABEL_SHAPE = new RegExp(`^${KEBAB_WORD}\\.${KEBAB_WORD}$`, "u");
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
      missingLabel:
        '`detached(promise, context)` needs a context label. Pass a `"feature.action"` string literal naming the module and the work being detached.',
      nonLiteralLabel:
        'The `detached` context label must be a plain `"feature.action"` string literal, so the telemetry tag stays stable and cannot carry an interpolated identifier. If a helper detaches for several call sites, return the promise and let each site pass its own literal.',
      badLabelShape:
        'The `detached` context label must be two lowercase kebab-case segments, `"feature.action"` (for example `"template-list.invalidate-templates"`). Name the module or route slice, then the work being detached; an enclosing component or handler name is neither stable nor distinguishing.',
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") {
          return;
        }
        if (node.callee.name !== "detached") {
          return;
        }
        const label = node.arguments.at(1);
        if (label === undefined) {
          context.report({ node, messageId: "missingLabel" });
          return;
        }
        if (!isStringLiteral(label)) {
          context.report({ node: label, messageId: "nonLiteralLabel" });
          return;
        }
        if (LABEL_SHAPE.test(label.value)) {
          return;
        }
        context.report({ node: label, messageId: "badLabelShape" });
      },
    };
  },
};
