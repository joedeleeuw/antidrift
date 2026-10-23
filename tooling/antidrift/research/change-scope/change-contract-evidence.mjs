import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { gitOrThrow } from "./change-context.mjs";
import { runChangeContract } from "./change-contract.mjs";

const repoPlans = {
  "sudocode-main": [
    process.env.SUDOCODE_REPO,
    resolve(homedir(), "code", "sudocode-main"),
  ].filter(Boolean),
};

const cases = [
  {
    id: "sudocode-spec-kit-deps-undeclared-copilotkit",
    repo: "sudocode-main",
    sha: "cf3d9ccf",
    kind: "gold-tp",
    subject: "add spec-kit deps",
    contract: contract({
      id: "CC-GOLD-TP-1",
      task: "add spec-kit deps",
      allowedPaths: [
        ".sudocode/issues.jsonl",
        ".sudocode/specs.jsonl",
        "frontend/package.json",
        "package-lock.json",
      ],
      checkedSurfaces: ["paths", "changeTypes", "dependencies"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["undeclared-runtime-dependency"],
      dependencies: [
        "@copilotkit/react-core",
        "@copilotkit/react-ui",
        "@copilotkit/runtime",
      ],
    },
  },
  {
    id: "sudocode-claude-md-submodule-removal",
    repo: "sudocode-main",
    sha: "6c7c672",
    kind: "gold-tp",
    subject: "update claude.md",
    contract: contract({
      id: "CC-GOLD-TP-2",
      task: "update claude.md",
      allowedPaths: [".claude/CLAUDE.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: [".gitmodules", "references/beads"],
    },
  },
  {
    id: "sudocode-version-bump-submodule-additions",
    repo: "sudocode-main",
    sha: "c2fcd1d",
    kind: "gold-tp",
    subject:
      "update version incrementing script and upgrade minor version for test release",
    contract: contract({
      id: "CC-GOLD-TP-3",
      task: "update version incrementing script and upgrade minor version for test release",
      allowedPaths: [
        "**/package.json",
        "**/package-lock.json",
        "scripts/version.sh",
      ],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: [
        ".gitmodules",
        "references/CodeMachine-CLI",
        "references/agentapi",
        "references/beads",
        "references/claude-flow",
        "references/vibe-kanban",
      ],
    },
  },
  {
    id: "sudocode-skill-content-submodule-additions",
    repo: "sudocode-main",
    sha: "f722716",
    kind: "gold-tp",
    subject: "update skill content to show preference for direct md changes",
    contract: contract({
      id: "CC-GOLD-TP-4",
      task: "update skill content to show preference for direct md changes",
      allowedPaths: ["skills/sudocode/SKILL.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: {
      violationTypes: ["path-out-of-scope"],
      paths: ["references/toad", "references/vibe-kanban"],
    },
  },
  {
    id: "sudocode-readme-plugin-install-clean",
    repo: "sudocode-main",
    sha: "52dec81e",
    kind: "true-negative",
    subject: "Clarify plugin installation instructions in README (#152)",
    contract: contract({
      id: "CC-TN-1",
      task: "Clarify plugin installation instructions in README (#152)",
      allowedPaths: ["README.md"],
      checkedSurfaces: ["paths", "changeTypes"],
      allowedChangeTypes: ["modify"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "sudocode-js-yaml-dependency-clean",
    repo: "sudocode-main",
    sha: "d0ea172b",
    kind: "true-negative",
    subject: "[Workflow 1/6] i-7v2c: Add js-yaml dependency to cli package",
    contract: contract({
      id: "CC-TN-2",
      task: "[Workflow 1/6] i-7v2c: Add js-yaml dependency to cli package",
      allowedPaths: [
        ".sudocode/issues.jsonl",
        "cli/package.json",
        "package-lock.json",
      ],
      checkedSurfaces: ["paths", "changeTypes", "dependencies"],
      allowedChangeTypes: ["modify"],
      allowedRuntimeDependencies: ["js-yaml"],
      allowedDevDependencies: ["@types/js-yaml"],
    }),
    expected: { violationTypes: [] },
  },
  {
    id: "sudocode-yaml-converter-clean",
    repo: "sudocode-main",
    sha: "0402e9eb",
    kind: "true-negative",
    subject:
      "[Workflow 2/9] i-9afp: Implement YAML Converter with Multi-Line Support",
    contract: contract({
      id: "CC-TN-3",
      task: "[Workflow 2/9] i-9afp: Implement YAML Converter with Multi-Line Support",
      allowedPaths: [
        "cli/src/yaml-converter.ts",
        "cli/tests/unit/yaml-converter.test.ts",
      ],
      checkedSurfaces: ["paths", "changeTypes", "exports"],
      allowedChangeTypes: ["add"],
      allowedExports: [
        {
          file: "cli/src/yaml-converter.ts",
          name: "YamlConverterOptions",
          kind: "type",
        },
        { file: "cli/src/yaml-converter.ts", name: "fromYaml", kind: "value" },
        {
          file: "cli/src/yaml-converter.ts",
          name: "fromYamlDocuments",
          kind: "value",
        },
        { file: "cli/src/yaml-converter.ts", name: "toYaml", kind: "value" },
        {
          file: "cli/src/yaml-converter.ts",
          name: "toYamlDocuments",
          kind: "value",
        },
        {
          file: "cli/src/yaml-converter.ts",
          name: "verifyRoundTrip",
          kind: "value",
        },
      ],
    }),
    expected: { violationTypes: [] },
  },
];

function contract({
  id,
  task,
  allowedPaths,
  checkedSurfaces,
  allowedChangeTypes,
  allowedRuntimeDependencies = [],
  allowedDevDependencies = [],
  allowedExports = [],
  refactor,
}) {
  const result = {
    schemaVersion: 1,
    contractId: id,
    task,
    scope: {
      allowedPaths,
      checkedSurfaces,
      allowedChangeTypes,
      allowedRuntimeDependencies,
      allowedDevDependencies,
      allowedExports,
    },
  };
  if (refactor) result.refactor = refactor;
  return result;
}

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

export function parseArgs(argv) {
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
  return cases.filter(
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

function assertCommit(repoRoot, sha) {
  gitOrThrow(["rev-parse", "--verify", `${sha}^{commit}`], repoRoot);
}

function caseDecision(item, result) {
  const violations = result.violations;
  const expectedTypes = new Set(item.expected.violationTypes);
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
  const missingTypes = [...expectedTypes].filter(
    (type) => !actualTypes.has(type)
  );
  const missingDependencies = (item.expected.dependencies ?? []).filter(
    (dependency) => !actualDependencies.has(dependency)
  );
  const missingPaths = (item.expected.paths ?? []).filter(
    (path) => !actualPaths.has(path)
  );
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
  assertCommit(repoRoot, item.sha);
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
    contractId: item.contract.contractId,
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

export function changeContractEvidence(parsed) {
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
    const report = {
      schemaVersion: 1,
      command: "research change-contract-evidence",
      slice: parsed.slice,
      decision: results.every((result) => result.decision === "pass")
        ? "pass"
        : "fail",
      caseCounts: {
        total: results.length,
        goldTp: results.filter((result) => result.kind === "gold-tp").length,
        trueNegative: results.filter(
          (result) => result.kind === "true-negative"
        ).length,
        failed: results.filter((result) => result.decision === "fail").length,
      },
      repositories: Object.entries(repoRoots)
        .map(([repo, repoRoot]) => ({ repo, repoRoot }))
        .sort((left, right) => compareStrings(left.repo, right.repo)),
      cases: results,
    };
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
