import { loadNativeAddon } from "../policy/oxlint.mjs";

const RULE_PREFIX = "antidrift/";

const addon = loadNativeAddon();

const currentFile = { filename: "", findings: [] };

function findingsFor(context) {
  if (currentFile.filename !== context.filename) {
    currentFile.findings = addon.lintFile(context.cwd, context.filename);
    currentFile.filename = context.filename;
  }
  return currentFile.findings;
}

function bridgeRule(ruleId) {
  return {
    meta: { type: "problem" },
    create(context) {
      return {
        Program() {
          for (const finding of findingsFor(context)) {
            if (finding.rule !== ruleId) {
              continue;
            }
            context.report({
              message: finding.message,
              loc: {
                start: { line: finding.line, column: finding.column - 1 },
                end: { line: finding.endLine, column: finding.endColumn - 1 },
              },
            });
          }
        },
      };
    },
  };
}

function localRuleName(ruleId) {
  if (!ruleId.startsWith(RULE_PREFIX)) {
    throw new Error(
      `The antidrift addon registered ${ruleId}, which lacks the ${RULE_PREFIX} prefix the Oxlint plugin namespace requires.`
    );
  }
  return ruleId.slice(RULE_PREFIX.length);
}

export default {
  meta: { name: "antidrift" },
  rules: Object.fromEntries(
    addon
      .antidriftRules()
      .map(({ name }) => [localRuleName(name), bridgeRule(name)])
  ),
};
