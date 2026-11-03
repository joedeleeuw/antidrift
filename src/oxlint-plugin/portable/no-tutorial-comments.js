import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  getCommentText,
  isFixtureOrDocsFile,
  isTestFilename,
  toNodeArray,
} from "./syntax.js";

const TUTORIAL_COMMENT_PATTERN =
  /^\s*(this|here|we)\b.*\b(checks?|ensures?|handles?|returns?|gets?|sets?|does|validates?)\b/i;

const SECTION_DIVIDER_PATTERN =
  /^\s*(?:={4,}|-{4,}|\*{4,}|~{4,}).*$|^\s*[A-Za-z0-9 _-]+\s*(?:={4,}|-{4,})\s*$/u;

const noTutorialCommentsRule = {
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
        "Disallow tutorial-style explanatory comments and ASCII section divider banners.",
    },
    messages: {
      tutorial:
        "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
      sectionDivider:
        "ASCII section-divider comment detected. Split the module along the domain seam instead of dividing it with banners.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    if (isTestFilename(context.filename)) return {};
    if (isFixtureOrDocsFile(context.filename)) return {};
    return {
      Program() {
        for (const comment of toNodeArray(
          context.sourceCode.getAllComments()
        )) {
          const text = getCommentText(comment);
          if (TUTORIAL_COMMENT_PATTERN.test(text)) {
            context.report({ node: comment, messageId: "tutorial" });
          } else if (
            comment.type === "Line" &&
            SECTION_DIVIDER_PATTERN.test(text)
          ) {
            context.report({ node: comment, messageId: "sectionDivider" });
          }
        }
      },
    };
  },
};
export default noTutorialCommentsRule;
