import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { gitOrThrow } from "./change-context.mjs";
import { runChangeContract } from "./change-contract.mjs";

import { evidenceCases } from "./change-contract-cases.mjs";

const repoPlans = {
  "sudocode-main": [
    process.env.SUDOCODE_REPO,
    resolve(homedir(), "code", "sudocode-main"),
  ].filter(Boolean),
  chaski: [
    process.env.CHASKI_REPO,
    resolve(homedir(), "code", "chaski"),
  ].filter(Boolean),
};

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`change-contract-evidence: ${flag} requires a value`);
  }
  return value;
}

const argumentOptions = {
  "--output": { field: "output", read: String },
  "--slice": { field: "slice", read: String },
  "--repo": { field: "repo", read: parseCsv },
  "--case": { field: "caseIds", read: parseCsv },
};

function parseArgs(argv) {
  const parsed = {
    output: null,
    slice: "change-contract-mvp-evidence",
    repo: null,
    caseIds: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const option = Object.hasOwn(argumentOptions, arg)
      ? argumentOptions[arg]
      : null;
    if (!option) {
      throw new Error(`change-contract-evidence: unknown argument "${arg}"`);
    }
    parsed[option.field] = option.read(requireValue(argv, index, arg));
    index += 1;
  }
  return parsed;
}

function selectedCases(parsed) {
  const repoFilter = parsed.repo ? new Set(parsed.repo) : null;
  const caseFilter = parsed.caseIds ? new Set(parsed.caseIds) : null;
  return evidenceCases.filter(
    (item) =>
      (!repoFilter || repoFilter.has(item.repo)) &&
      (!caseFilter || caseFilter.has(item.id))
  );
}

function repoRootFor(repo) {
  const candidates = repoPlans[repo];
  if (!candidates) {
    throw new Error(`change-contract-evidence: unknown repo "${repo}"`);
  }
  const root = candidates.find((candidate) => {
    try {
      gitOrThrow(["rev-parse", "--git-dir"], candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!root) {
    throw new Error(
      `change-contract-evidence: repo "${repo}" not found in candidates: ${candidates.join(", ")}`
    );
  }
  return root;
}

function missingExpectations(expected, violations) {
  const actualTypes = new Set(violations.map((violation) => violation.type));
  const actualDependencies = new Set(
    violations
      .map((violation) => violation.dependency)
      .filter((dependency) => typeof dependency === "string")
  );
  const actualPaths = new Set(
    violations
      .map((violation) => violation.path)
      .filter((path) => typeof path === "string")
  );
  return {
    missingTypes: [...new Set(expected.violationTypes)].filter(
      (type) => !actualTypes.has(type)
    ),
    missingDependencies: (expected.dependencies ?? []).filter(
      (dependency) => !actualDependencies.has(dependency)
    ),
    missingPaths: (expected.paths ?? []).filter(
      (path) => !actualPaths.has(path)
    ),
  };
}

function caseDecision(item, result) {
  const violations = result.violations;
  const { missingTypes, missingDependencies, missingPaths } =
    missingExpectations(item.expected, violations);
  const unexpectedClean = item.kind === "gold-tp" && violations.length === 0;
  const unexpectedViolation =
    item.kind === "true-negative" && violations.length > 0;
  const decision =
    missingTypes.length === 0 &&
    missingDependencies.length === 0 &&
    missingPaths.length === 0 &&
    !unexpectedClean &&
    !unexpectedViolation
      ? "pass"
      : "fail";
  return {
    decision,
    missingTypes,
    missingDependencies,
    missingPaths,
    unexpectedClean,
    unexpectedViolation,
  };
}

function replayCase(item, repoRoot, tempRoot) {
  gitOrThrow(["rev-parse", "--verify", `${item.sha}^{commit}`], repoRoot);
  const contractPath = resolve(tempRoot, `${item.id}.json`);
  writeFileSync(contractPath, `${JSON.stringify(item.contract, null, 2)}\n`);
  const result = runChangeContract({
    contractPath,
    base: `${item.sha}^`,
    head: item.sha,
    cwd: repoRoot,
    requireContract: true,
  });
  const expectation = caseDecision(item, result);
  return {
    id: item.id,
    repo: item.repo,
    repoRoot,
    sha: item.sha,
    kind: item.kind,
    subject: item.subject,
    expected: item.expected,
    contractState: result.contractState,
    changeContext: result.changeContext,
    violationCount: result.violations.length,
    violationTypes: [
      ...new Set(result.violations.map((violation) => violation.type)),
    ].sort(compareStrings),
    violations: result.violations,
    expectation,
    decision: expectation.decision,
  };
}

function writeReport(output, report) {
  const target = resolve(process.cwd(), output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

function evidenceReport(slice, repoRoots, results) {
  return {
    schemaVersion: 1,
    command: "antidrift change-contract-evidence",
    slice,
    decision: results.every((result) => result.decision === "pass")
      ? "pass"
      : "fail",
    caseCounts: {
      total: results.length,
      goldTp: results.filter((result) => result.kind === "gold-tp").length,
      trueNegative: results.filter((result) => result.kind === "true-negative")
        .length,
      failed: results.filter((result) => result.decision === "fail").length,
    },
    repositories: Object.entries(repoRoots)
      .map(([repo, repoRoot]) => ({ repo, repoRoot }))
      .sort((left, right) => compareStrings(left.repo, right.repo)),
    cases: results,
  };
}

function changeContractEvidence(parsed) {
  const selected = selectedCases(parsed);
  if (selected.length === 0) {
    throw new Error("change-contract-evidence: no cases selected");
  }
  const repoRoots = Object.fromEntries(
    [...new Set(selected.map((item) => item.repo))]
      .sort(compareStrings)
      .map((repo) => [repo, repoRootFor(repo)])
  );
  const tempRoot = mkdtempSync(resolve(tmpdir(), "antidrift-change-contract-"));
  try {
    const results = selected.map((item) =>
      replayCase(item, repoRoots[item.repo], tempRoot)
    );
    const report = evidenceReport(parsed.slice, repoRoots, results);
    if (parsed.output) writeReport(parsed.output, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function changeContractEvidenceCommand(argv) {
  const report = changeContractEvidence(parseArgs(argv));
  if (report.decision !== "pass") process.exitCode = 1;
  return report;
}
