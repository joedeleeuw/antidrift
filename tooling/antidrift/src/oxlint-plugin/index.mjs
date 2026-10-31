import { loadNativeAddon } from "../policy/oxlint.mjs";

const RULE_PREFIX = "antidrift/";

const addon = loadNativeAddon();
process.env.ANTIDRIFT_ENGINE = addon.engineEndpoint();

const enabledRules = new Set();
const currentFile = { filename: "", requested: new Set(), findings: new Map() };

function enterFile(filename, ruleId) {
  if (currentFile.filename !== filename || currentFile.requested.has(ruleId)) {
    currentFile.filename = filename;
    currentFile.requested = new Set();
    currentFile.findings = new Map();
  }
  currentFile.requested.add(ruleId);
}

function lintRules(context, ruleIds) {
  const unlinted = ruleIds.filter(
    (ruleId) => !currentFile.findings.has(ruleId)
  );
  if (unlinted.length === 0) {
    return;
  }
  const findings = addon.lintFile(context.cwd, context.filename, unlinted);
  for (const ruleId of unlinted) {
    currentFile.findings.set(ruleId, []);
  }
  for (const finding of findings) {
    currentFile.findings.get(finding.rule).push(finding);
  }
}

function reportFindings(context, ruleId) {
  for (const finding of currentFile.findings.get(ruleId)) {
    context.report({
      message: finding.message,
      loc: {
        start: { line: finding.line, column: finding.column - 1 },
        end: { line: finding.endLine, column: finding.endColumn - 1 },
      },
    });
  }
}

function bridgeRule(ruleId) {
  return {
    meta: { type: "problem" },
    createOnce(context) {
      return {
        before() {
          enterFile(context.filename, ruleId);
          if (!enabledRules.has(ruleId)) {
            enabledRules.add(ruleId);
            return true;
          }
          if (!currentFile.findings.has(ruleId)) {
            lintRules(context, [...enabledRules]);
          }
          reportFindings(context, ruleId);
          return false;
        },
        Program() {
          if (!currentFile.findings.has(ruleId)) {
            lintRules(context, [...currentFile.requested]);
          }
          reportFindings(context, ruleId);
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
