import { loadNativeAddon } from "../policy/oxlint.mjs";

const RULE_PREFIX = "antidrift/";

const addon = loadNativeAddon();
process.env.ANTIDRIFT_ENGINE = addon.engineEndpoint();

const enabledRules = new Map();
const currentFile = {
  cwd: "",
  filename: "",
  requested: new Map(),
  findings: new Map(),
};

function optionsOf(context) {
  const options = context.options;
  return Array.isArray(options) && options.length > 0
    ? JSON.stringify(options)
    : undefined;
}

function resetFile(cwd, filename) {
  currentFile.cwd = cwd;
  currentFile.filename = filename;
  currentFile.requested = new Map();
  currentFile.findings = new Map();
}

function enterFile(cwd, filename, ruleId, options) {
  if (
    currentFile.cwd !== cwd ||
    currentFile.filename !== filename ||
    currentFile.requested.has(ruleId)
  ) {
    resetFile(cwd, filename);
  }
  currentFile.requested.set(ruleId, options);
}

function isLinted(ruleId, options) {
  const cached = currentFile.findings.get(ruleId);
  return cached !== undefined && cached.options === options;
}

function lintRules(requests) {
  const unlinted = [...requests].filter(
    ([ruleId, options]) => !isLinted(ruleId, options)
  );
  if (unlinted.length === 0) {
    return;
  }
  const findings = addon.lintFile(
    currentFile.cwd,
    currentFile.filename,
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
      node: { range: [finding.start, finding.end] },
    });
  }
}

function bridgeRule(ruleId) {
  return {
    meta: { type: "problem", schema: false },
    create(context) {
      enterFile(context.cwd, context.filename, ruleId, optionsOf(context));
      return {
        Program() {
          lintRules(currentFile.requested);
          reportFindings(context, ruleId);
        },
      };
    },
    createOnce(context) {
      return {
        before() {
          const options = optionsOf(context);
          enterFile(context.cwd, context.filename, ruleId, options);
          if (!enabledRules.has(ruleId)) {
            enabledRules.set(ruleId, options);
            return true;
          }
          enabledRules.set(ruleId, options);
          lintRules(new Map([...enabledRules, ...currentFile.requested]));
          reportFindings(context, ruleId);
          return false;
        },
        Program() {
          lintRules(currentFile.requested);
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
    addon.antidriftRules().flatMap(({ name, lineCap }) => {
      const local = localRuleName(name);
      const entries = [[local, bridgeRule(name)]];
      if (lineCap) {
        entries.push([`${local}-near`, bridgeRule(`${name}-near`)]);
      }
      return entries;
    })
  ),
};
