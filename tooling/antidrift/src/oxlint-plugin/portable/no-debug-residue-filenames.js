import { isRuleFile, scopeProperties } from "./scope.js";

const DEBUG_FILENAME_PATTERN =
  /(?:^|\/)[^/]*(?:_old|_backup|_temp|_v2|\.bak|\.old|\.backup)(?:\.[^/]+)?$/i;
export const noDebugResidueFilenamesRule = {
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
        "Disallow filenames that look like debug residue, backups, or throwaway revisions.",
    },
    messages: {
      debugResidue:
        "Filename '{{filename}}' looks like debug residue. Rename the file to its real intent.",
    },
  },
  create(context) {
    if (!isRuleFile(context)) return {};

    return {
      Program(node) {
        const filename = context.filename;
        if (!filename || !DEBUG_FILENAME_PATTERN.test(filename)) {
          return;
        }
        context.report({
          node,
          messageId: "debugResidue",
          data: { filename },
        });
      },
    };
  },
};
export default noDebugResidueFilenamesRule;
