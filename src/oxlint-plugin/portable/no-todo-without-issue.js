import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import { getString, toNode, toNodeArray } from "./syntax.js";

const TOKEN_PATTERN = /(?:^|[\s*@/])(TODO|FIXME|HACK|@todo|@fixme)\b/gm;
const TICKET_PATTERN =
  /^(?:\s*(?:\(|\[|:)\s*[A-Z]{2,}-\d+|\s+[A-Z]{2,}-\d+|\s*\(#\d+\))/;
const AI_DEBT_PATTERN =
  /\b(?:ai[- ]generated|llm|copilot|claude|gemini|cursor)\b/i;
const getCommentText = (comment) => {
  const commentNode = toNode(comment);
  if (!commentNode) {
    return "";
  }
  const commentText = getString(commentNode.value);
  if (commentText) {
    return commentText;
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
          for (const match of text.matchAll(TOKEN_PATTERN)) {
            const token = match[1];
            const markerEnd = match.index + match[0].length;
            if (TICKET_PATTERN.test(text.slice(markerEnd))) continue;
            const lineStart = text.lastIndexOf("\n", markerEnd) + 1;
            const nextLine = text.indexOf("\n", markerEnd);
            const line = text.slice(
              lineStart,
              nextLine === -1 ? text.length : nextLine
            );
            const forbidden = AI_DEBT_PATTERN.test(line);
            context.report({
              node: comment,
              messageId: forbidden ? "forbidden" : "bareToken",
              ...(forbidden
                ? {}
                : { data: { token: token.replace(/^@/u, "").toUpperCase() } }),
            });
          }
        }
      },
    };
  },
};
export default noTodoWithoutIssueRule;
