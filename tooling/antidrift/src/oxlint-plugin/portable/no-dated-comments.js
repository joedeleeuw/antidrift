import { isRuleFile, scopeProperties } from "./scope.js";

const DATE = /(?:^|[^\w-])20\d{2}-?[01]\d-?[0-3]\d(?=[^\w-]|$)(?! \d{1,2}:\d{2})/;
const EXAMPLE = /@example|```/;

function trailsCode(comment, text) {
  const lineStart = text.lastIndexOf("\n", comment.range[0] - 1) + 1;
  return text.slice(lineStart, comment.range[0]).trim() !== "";
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow dated provenance prose in comments.",
    },
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],
    messages: {
      datedComment:
        "Dated provenance prose in a comment. History belongs in commit bodies and field notes, not in code.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    const { sourceCode } = context;
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (
            DATE.test(comment.value) &&
            !EXAMPLE.test(comment.value) &&
            !trailsCode(comment, sourceCode.text)
          ) {
            context.report({ node: comment, messageId: "datedComment" });
          }
        }
      },
    };
  },
};
