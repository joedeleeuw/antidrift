import {
  isRuleFile,
  scopeProperties,
} from "../../semantic-adapters/kernel/rule-scope.ts";
import { getString, toNode, toNodeArray } from "./syntax.js";

const TOKEN_PATTERN = /\b(TODO|FIXME|HACK)\b/i;
const TICKET_PATTERN = /\b(?:TODO|FIXME|HACK)\s*(?:\(|\[|:)\s*[A-Z]{2,}-\d+/i;
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
const noTodoWithoutIssueRule = {
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
        "Require tracked issues for debt comments, including acknowledged AI-generated debt.",
    },
    messages: {
      bareToken:
        "{{token}} comment must include a tracked issue reference (e.g. TODO(ABC-123)).",
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
          if (TICKET_PATTERN.test(text)) continue;
          if (DEBT_TOKEN_PATTERN.test(text) && AI_TOKEN_PATTERN.test(text)) {
            context.report({ node: comment, messageId: "forbidden" });
            continue;
          }
          const match = TOKEN_PATTERN.exec(text);
          if (!match?.[1]) continue;
          context.report({
            node: comment,
            messageId: "bareToken",
            data: { token: match[1].toUpperCase() },
          });
        }
      },
    };
  },
};
export default noTodoWithoutIssueRule;
