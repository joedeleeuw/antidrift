import { isRuleFile, scopeProperties } from "./scope.js";
import { getString, toNode, toNodeArray } from "./syntax.js";

const DEBT_TOKEN_PATTERN = /\b(todo|fixme|hack|temporary|later|cleanup)\b/i;
const AI_TOKEN_PATTERN =
  /\b(ai|llm|gpt|copilot|claude|gemini|cursor|generated)\b/i;
const getCommentText = (value) => {
  const commentNode = toNode(value);
  if (!commentNode) {
    return "";
  }
  const fromValue = getString(commentNode.value);
  if (fromValue) {
    return fromValue;
  }
  const fromRaw = getString(commentNode.raw);
  if (fromRaw) {
    return fromRaw;
  }
  return "";
};
export const noAiDebtCommentsRule = {
  meta: {
    schema: [
      {
        type: "object",
        properties: scopeProperties,
        additionalProperties: false,
      },
    ],

    type: "problem",
    docs: {
      description:
        "Disallow comments that acknowledge AI-generated debt without immediate resolution.",
    },
    messages: {
      forbidden:
        "AI debt comment is forbidden. Replace with immediate fix or a tracked issue reference outside source files.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      Program() {
        const comments = toNodeArray(context.sourceCode.getAllComments());
        for (const comment of comments) {
          const text = getCommentText(comment);
          if (!DEBT_TOKEN_PATTERN.test(text) || !AI_TOKEN_PATTERN.test(text)) {
            continue;
          }
          context.report({ node: comment, messageId: "forbidden" });
        }
      },
    };
  },
};
export default noAiDebtCommentsRule;
