import { isRuleFile, scopeProperties } from "./scope.js";
import {
  getCommentText,
  isFixtureOrDocsFile,
  isTestFilename,
  toNodeArray,
} from "./syntax.js";

const TUTORIAL_COMMENT_PATTERN =
  /^\s*(this|here|we)\b.*\b(checks?|ensures?|handles?|returns?|gets?|sets?|does|validates?)\b/i;
export const noTutorialCommentsRule = {
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
        "Disallow tutorial-style explanatory comments that restate obvious code.",
    },
    messages: {
      tutorial:
        "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    if (isTestFilename(context.filename)) {
      return {};
    }
    if (isFixtureOrDocsFile(context.filename)) {
      return {};
    }
    return {
      Program() {
        for (const comment of toNodeArray(
          context.sourceCode.getAllComments(),
        )) {
          if (!TUTORIAL_COMMENT_PATTERN.test(getCommentText(comment))) {
            continue;
          }
          context.report({ node: comment, messageId: "tutorial" });
        }
      },
    };
  },
};
export default noTutorialCommentsRule;
