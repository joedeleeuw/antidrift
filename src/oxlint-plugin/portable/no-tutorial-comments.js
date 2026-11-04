import { isRuleFile, scopeProperties } from "../shared/rule-scope.js";
import {
  getCommentText,
  isFixtureOrDocsFile,
  isMigrationFile,
  isTestFilename,
  toNodeArray,
} from "./syntax.js";

const TUTORIAL_COMMENT_PATTERN =
  /^\s*(this|here|we)\b.*\b(checks?|ensures?|handles?|returns?|gets?|sets?|does|validates?)\b/i;

const SECTION_DIVIDER_PATTERN =
  /^\s*(?:={4,}|-{4,}|\*{4,}|~{4,}).*$|^\s*[A-Za-z0-9 _-]+\s*(?:={4,}|-{4,})\s*$/u;

const DATE_PATTERN =
  /(?:^|[^\w-])20\d{2}-?[01]\d-?[0-3]\d(?=[^\w-]|$)(?! \d{1,2}:\d{2})/;
const EXAMPLE_PATTERN = /@example|```/;
const QUOTED_OR_URL =
  /"[^"\n]*"|`[^`\n]*`|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])|\b[a-z][\w+.-]*:\/\/\S+/gi;

function trailsCode(comment, text) {
  const lineStart = text.lastIndexOf("\n", comment.range[0] - 1) + 1;
  return text.slice(lineStart, comment.range[0]).trim() !== "";
}

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
        "Disallow tutorial-style explanatory comments, ASCII section divider banners, and dated provenance prose in comments.",
    },
    messages: {
      tutorial:
        "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
      sectionDivider:
        "ASCII section-divider comment detected. Split the module along the domain seam instead of dividing it with banners.",
      datedComment:
        "Dated provenance prose in a comment. History belongs in commit bodies and field notes, not in code.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};
    const { sourceCode } = context;
    const skipDated =
      isMigrationFile(context.filename) ||
      isFixtureOrDocsFile(context.filename);
    const skipTutorial =
      isTestFilename(context.filename) || isFixtureOrDocsFile(context.filename);

    return {
      Program() {
        for (const comment of toNodeArray(sourceCode.getAllComments())) {
          const text = getCommentText(comment);
          if (
            !skipDated &&
            DATE_PATTERN.test(text.replaceAll(QUOTED_OR_URL, " ")) &&
            !EXAMPLE_PATTERN.test(text) &&
            !trailsCode(comment, sourceCode.text)
          ) {
            context.report({ node: comment, messageId: "datedComment" });
            continue;
          }
          if (skipTutorial) continue;
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
