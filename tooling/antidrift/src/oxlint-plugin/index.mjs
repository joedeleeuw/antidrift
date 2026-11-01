import { loadNativeAddon } from "../policy/oxlint.mjs";

const RULE_PREFIX = "antidrift/";

const addon = loadNativeAddon();
process.env.ANTIDRIFT_ENGINE = addon.engineEndpoint();

const enabledRules = new Map();
const currentFile = {
  filename: "",
  sourceText: "",
  requested: new Map(),
  findings: new Map(),
};

function optionsOf(context) {
  const options = context.options;
  return Array.isArray(options) && options.length > 0
    ? JSON.stringify(options)
    : undefined;
}

function enterFile(filename, sourceText, ruleId, options) {
  if (
    currentFile.filename !== filename ||
    currentFile.sourceText !== sourceText ||
    currentFile.requested.has(ruleId)
  ) {
    currentFile.filename = filename;
    currentFile.sourceText = sourceText;
    currentFile.requested = new Map();
    currentFile.findings = new Map();
  }
  currentFile.requested.set(ruleId, options);
}

function isLinted(ruleId, options) {
  const cached = currentFile.findings.get(ruleId);
  return cached !== undefined && cached.options === options;
}

function lintRules(context, requests) {
  const unlinted = [...requests].filter(
    ([ruleId, options]) => !isLinted(ruleId, options)
  );
  if (unlinted.length === 0) {
    return;
  }
  const findings = addon.lintFile(
    context.cwd,
    context.filename,
    currentFile.sourceText,
    process.env.ANTIDRIFT_LINT_RUN ?? null,
    unlinted.map(([rule, options]) => ({ rule, options }))
  );
  for (const [ruleId, options] of unlinted) {
    currentFile.findings.set(ruleId, { options, findings: [] });
  }
  for (const finding of findings) {
    currentFile.findings.get(finding.rule).findings.push(finding);
  }
}

function reportFindings(context, ruleId) {
  for (const finding of currentFile.findings.get(ruleId).findings) {
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
    meta: { type: "problem", schema: false },
    createOnce(context) {
      return {
        before() {
          const options = optionsOf(context);
          enterFile(context.filename, context.sourceCode.text, ruleId, options);
          if (!enabledRules.has(ruleId)) {
            enabledRules.set(ruleId, options);
            return true;
          }
          enabledRules.set(ruleId, options);
          if (!isLinted(ruleId, options)) {
            lintRules(
              context,
              new Map([...enabledRules, ...currentFile.requested])
            );
          }
          reportFindings(context, ruleId);
          return false;
        },
        Program() {
          if (!isLinted(ruleId, currentFile.requested.get(ruleId))) {
            lintRules(context, currentFile.requested);
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
