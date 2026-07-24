import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { corpusRepoPresence, runCorpusCases } from "../chaski-corpus.mjs";
import { coreRuleIds, externalCorpora } from "./cases.mjs";

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRuleId(rule) {
  if (rule.includes("/")) return rule;
  if (coreRuleIds.has(rule)) return rule;
  return `antidrift/${rule}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const valueArgHandlers = {
  "--repo": (out, value) => {
    out.repo = value;
  },
  "--corpus": (out, value) => {
    out.corpus = value;
  },
  "--slice": (out, value) => {
    out.slice = value;
  },
  "--output": (out, value) => {
    out.output = value;
  },
  "--rules": (out, value) => {
    out.rules = parseCsv(value).map(normalizeRuleId);
  },
  "--min-repositories": (out, value) => {
    out.minRepositories = parsePositiveInteger(value, out.minRepositories);
  },
  "--min-drift-repositories": (out, value) => {
    out.minDriftRepositories = parsePositiveInteger(
      value,
      out.minDriftRepositories,
    );
  },
};

function applyValueArg(out, arg, value) {
  const handler = valueArgHandlers[arg];
  if (!handler || !value) return false;
  handler(out, value);
  return true;
}

export function parseArgs(argv) {
  const out = {
    repo: null,
    corpus: null,
    slice: "external-corpus",
    output: null,
    require: false,
    rules: null,
    minRepositories: 1,
    minDriftRepositories: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (applyValueArg(out, arg, next)) {
      i += 1;
    } else if (arg === "--require") {
      out.require = true;
    }
  }
  return out;
}

function selectedCorpora(corpus) {
  if (!corpus) return externalCorpora;
  return externalCorpora.filter((entry) => entry.name === corpus);
}

function externalSlice(sharedOptions) {
  return sharedOptions.slice ?? "external-corpus";
}

function unknownCorpusSummary(corpus, sharedOptions) {
  return {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision: "fail",
    reason: `Unknown external corpus: ${corpus}. Known: ${externalCorpora.map((entry) => entry.name).join(", ")}`,
    repositories: [],
  };
}

function externalDecision({
  failed,
  passed,
  driftPassed,
  minRepositories,
  minDriftRepositories,
  require,
}) {
  if (failed) return "fail";
  if (driftPassed < minDriftRepositories) return passed > 0 ? "fail" : "skip";
  if (passed >= minRepositories) return "pass";
  if (passed > 0) return "fail";
  if (require) return "fail";
  return "skip";
}

function externalReason({
  decision,
  failed,
  passed,
  driftPassed,
  minRepositories,
  minDriftRepositories,
  repositories = [],
}) {
  if (decision === "skip") {
    return "No external corpus repositories were found. Pass --repo with --corpus or set a matching environment variable.";
  }
  if (failed) {
    const failedRepositories = repositories.filter(
      (result) => result.decision === "fail",
    );
    const firstFailure = failedRepositories[0];
    const firstFailedCase = firstFailure?.cases?.find(
      (testCase) => testCase.decision === "fail",
    );
    const detail = firstFailedCase?.reason ?? firstFailure?.reason;
    const prefix = `${failedRepositories.length} external corpus ${failedRepositories.length === 1 ? "repository" : "repositories"} failed`;
    return detail
      ? `${prefix}; ${firstFailure.corpus}: ${detail}`
      : `${prefix}.`;
  }
  if (!failed && driftPassed < minDriftRepositories) {
    return `Only ${driftPassed} external corpus repositories had passing drift cases; ${minDriftRepositories} required for this slice.`;
  }
  if (!failed && passed > 0 && passed < minRepositories) {
    return `Only ${passed} external corpus repositories passed; ${minRepositories} required for this slice.`;
  }
  return null;
}

function repositoryHasPassingDrift(result) {
  if (result.decision !== "pass") return false;
  return result.cases.some(
    (testCase) => testCase.kind === "drift" && testCase.decision === "pass",
  );
}

function runExternalCorpus(entry, sharedOptions) {
  return runCorpusCases({
    corpus: entry.name,
    corpusLabel: entry.label,
    repoCandidates: entry.repoCandidates,
    cases: entry.cases,
    output: null,
    report: () => {},
    ...sharedOptions,
  });
}

function externalRepositoryPresence(entry, sharedOptions) {
  return corpusRepoPresence({
    corpus: entry.name,
    corpusLabel: entry.label,
    repoCandidates: entry.repoCandidates,
    repo: sharedOptions.repo,
  });
}

function missingRepositoryReason(label) {
  return `${label} repo not found. Pass --repo or set the matching environment variable.`;
}

function skippedRepositorySummary(presence, slice, reason) {
  return {
    schemaVersion: 1,
    corpus: presence.corpus,
    slice,
    ...(presence.repoRoot ? { repoRoot: presence.repoRoot } : {}),
    decision: "skip",
    reason: presence.repoRoot
      ? reason
      : missingRepositoryReason(presence.label),
    cases: [],
  };
}

function externalPreconditionFailure({ available, minRepositories, require }) {
  if (!require) return null;
  if (available >= minRepositories) return null;
  return `Only ${available} external corpus repositories are available; ${minRepositories} required by --require for this slice.`;
}

function failingCaseLines(repository) {
  return (repository.cases ?? [])
    .filter((testCase) => testCase.decision === "fail")
    .map(
      (testCase) =>
        `  - ${testCase.id}: ${testCase.reason ?? "failed without a case reason"}`,
    );
}

function conciseSummary(summary, output) {
  const lines = [
    `external-corpus ${summary.decision}: ${
      summary.reason ?? "completed without a top-level reason"
    }`,
  ];
  if (output) lines.push(`report: ${output}`);
  for (const repository of summary.repositories.filter(
    (result) => result.decision !== "pass",
  )) {
    lines.push(
      `- ${repository.corpus}: ${repository.decision}${
        repository.reason ? ` - ${repository.reason}` : ""
      }`,
      ...failingCaseLines(repository),
    );
  }
  return lines.join("\n");
}

function emitSummary(summary, output, report) {
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    const target = resolve(output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json, "utf8");
    report(conciseSummary(summary, output));
  } else {
    report(json.trimEnd());
  }
}

export async function externalCorpus(options = {}) {
  const {
    corpus = null,
    output = null,
    report = console.log,
    minRepositories = 1,
    minDriftRepositories = 0,
    ...sharedOptions
  } = options;
  const corpora = selectedCorpora(corpus);
  if (corpus && corpora.length === 0) {
    const summary = unknownCorpusSummary(corpus, sharedOptions);
    emitSummary(summary, output, report);
    return summary;
  }

  const requireIndividualRepository = Boolean(
    sharedOptions.require && (corpus || sharedOptions.repo),
  );
  const presence = corpora.map((entry) =>
    externalRepositoryPresence(entry, sharedOptions),
  );
  const available = presence.filter((entry) => entry.repoRoot).length;
  const preconditionFailure = externalPreconditionFailure({
    available,
    minRepositories,
    require: sharedOptions.require,
  });
  if (preconditionFailure && !requireIndividualRepository) {
    const summary = {
      schemaVersion: 1,
      corpus: "external",
      slice: externalSlice(sharedOptions),
      decision: "fail",
      reason: preconditionFailure,
      minRepositories,
      minDriftRepositories,
      driftRepositories: 0,
      repositories: presence.map((entry) =>
        skippedRepositorySummary(
          entry,
          externalSlice(sharedOptions),
          preconditionFailure,
        ),
      ),
    };
    emitSummary(summary, output, report);
    return summary;
  }
  const repositories = await Promise.all(
    corpora.map((entry) =>
      runExternalCorpus(entry, {
        ...sharedOptions,
        require: requireIndividualRepository,
      }),
    ),
  );

  const passed = repositories.filter(
    (result) => result.decision === "pass",
  ).length;
  const driftPassed = repositories.filter(repositoryHasPassingDrift).length;
  const failed = repositories.some((result) => result.decision === "fail");
  const decision = externalDecision({
    failed,
    passed,
    driftPassed,
    minRepositories,
    minDriftRepositories,
    require: sharedOptions.require,
  });
  const reason = externalReason({
    decision,
    failed,
    passed,
    driftPassed,
    minRepositories,
    minDriftRepositories,
    repositories,
  });
  const summary = {
    schemaVersion: 1,
    corpus: "external",
    slice: externalSlice(sharedOptions),
    decision,
    minRepositories,
    minDriftRepositories,
    driftRepositories: driftPassed,
    repositories,
  };
  if (reason) summary.reason = reason;
  emitSummary(summary, output, report);
  return summary;
}
