import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import ts from "typescript";

import eslintPlugin from "../../src/eslint-plugin/index.js";
import oxlintPlugin from "../../src/oxlint-plugin/index.js";

// Runs labelled corpus cases (expected findings and clean controls) against a
// local checkout of a public repository.
const plugin = {
  meta: eslintPlugin.meta,
  rules: {
    ...eslintPlugin.rules,
    ...oxlintPlugin.rules,
  },
};

function resolveOxlintBinary() {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("oxlint/package.json");
  return resolve(dirname(packageJsonPath), require(packageJsonPath).bin.oxlint);
}

function findRepoRoot(repo, repoCandidates = []) {
  return corpusRepoPresence({ repo, repoCandidates }).repoRoot;
}

export function corpusRepoPresence({
  corpus = "corpus",
  corpusLabel = corpus,
  repoCandidates = [],
  repo = null,
} = {}) {
  const candidates = (repo ? [repo] : repoCandidates).filter(Boolean);
  const resolvedCandidates = candidates.map((candidate) => resolve(candidate));
  return {
    corpus,
    label: corpusLabel,
    repoRoot:
      resolvedCandidates.find((candidate) => existsSync(candidate)) ?? null,
  };
}

function relativeFile(repoRoot, filePath) {
  return relative(repoRoot, filePath).replace(/\\/gu, "/");
}

function ruleValueFor(testCase) {
  const options = testCase.ruleOptions?.[testCase.ruleId];
  return options ? ["error", ...options] : ["error"];
}

function typeAwareProjectFor(testCase) {
  if (!testCase.typeAware) return null;
  return testCase.tsconfig ?? null;
}

function programFilesFor(repoRoot, testCase) {
  return (testCase.programFiles ?? []).map((path) => resolve(repoRoot, path));
}

function programFor(repoRoot, testCase) {
  const rootNames = programFilesFor(repoRoot, testCase);
  if (rootNames.length === 0) return null;
  return ts.createProgram({
    rootNames,
    options: {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      noEmit: true,
      skipLibCheck: true,
    },
  });
}

function parserOptionsFor(repoRoot, testCase) {
  const program = programFor(repoRoot, testCase);
  if (program) {
    return {
      ecmaFeatures: { jsx: true },
      programs: [program],
      tsconfigRootDir: repoRoot,
    };
  }
  const project = typeAwareProjectFor(testCase);
  if (!project) return { ecmaFeatures: { jsx: true } };
  return {
    ecmaFeatures: { jsx: true },
    project: [project],
    tsconfigRootDir: repoRoot,
  };
}

function expectedFindingPresent(findings, expected) {
  return findings.some(
    (finding) =>
      finding.path === expected.path && finding.line === expected.line
  );
}

function unexpectedFindingPresent(findings, unexpected) {
  return findings.some(
    (finding) =>
      finding.path === unexpected.path && finding.line === unexpected.line
  );
}

function evaluateDriftFindings(testCase, findings, corpusLabel) {
  if (findings.length === 0) {
    return {
      decision: "fail",
      reason: `Expected ${corpusLabel} drift finding, but the rule stayed silent.`,
    };
  }
  for (const expected of testCase.expectedFindings ?? []) {
    if (!expectedFindingPresent(findings, expected)) {
      return {
        decision: "fail",
        reason: `Expected finding at ${expected.path}:${expected.line}.`,
      };
    }
  }
  return null;
}

function evaluateUnexpectedFindings(testCase, findings) {
  for (const unexpected of testCase.unexpectedFindings ?? []) {
    if (unexpectedFindingPresent(findings, unexpected)) {
      return {
        decision: "fail",
        reason: `Unexpected finding at ${unexpected.path}:${unexpected.line}.`,
      };
    }
  }
  return null;
}

function evaluateCase(
  testCase,
  findings,
  missingFiles,
  corpusLabel = "corpus"
) {
  if (missingFiles.length > 0) {
    return {
      decision: "fail",
      reason: `Missing ${corpusLabel} files: ${missingFiles.join(", ")}`,
    };
  }

  if (testCase.kind === "known-gap") {
    return {
      decision: "known-gap",
      reason:
        testCase.reason ??
        "Known rule/corpus gap; recorded but not blocking this validation gate.",
    };
  }

  const infrastructureFindings = findings.filter(
    (finding) => finding.ruleId == null
  );
  if (infrastructureFindings.length > 0) {
    return {
      decision: "fail",
      reason: `Lint runtime could not evaluate ${corpusLabel} source: ${infrastructureFindings[0].message}`,
    };
  }

  if (testCase.kind === "correct" && findings.length > 0) {
    return {
      decision: "fail",
      reason: `Expected clean ${corpusLabel} source, but the rule reported findings.`,
    };
  }

  if (testCase.kind === "drift") {
    const failure = evaluateDriftFindings(testCase, findings, corpusLabel);
    if (failure) return failure;
  }

  return (
    evaluateUnexpectedFindings(testCase, findings) ?? {
      decision: "pass",
      reason: null,
    }
  );
}

function oxlintRuleId(code) {
  const match = /^([^()]+)\(([^()]+)\)$/u.exec(code ?? "");
  return match ? `${match[1]}/${match[2]}` : code;
}

function oxlintFinding(repoRoot, diagnostic) {
  const span = diagnostic.labels?.[0]?.span ?? {};
  return {
    path: relativeFile(repoRoot, resolve(repoRoot, diagnostic.filename)),
    ruleId: oxlintRuleId(diagnostic.code),
    line: span.line,
    column: span.column,
    message: diagnostic.message,
  };
}

function lintOxlintCase(repoRoot, testCase) {
  const args = [
    resolveOxlintBinary(),
    "--disable-nested-config",
    "--import-plugin",
    "-A",
    "all",
    "-D",
    testCase.ruleId,
    "--format",
    "json",
  ];
  if (testCase.noIgnore === true) {
    args.push("--no-ignore");
  }
  if (testCase.standaloneOxlintConfig === true) {
    args.push(
      "--config",
      fileURLToPath(
        new URL("./external-corpus/oxlint.config.mts", import.meta.url)
      )
    );
  }
  const tsconfig = testCase.tsconfig;
  if (tsconfig) {
    args.push("--tsconfig", resolve(repoRoot, tsconfig));
  }
  args.push(...testCase.paths.map((path) => resolve(repoRoot, path)));
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    return [{ ruleId: null, message: result.error.message }];
  }
  try {
    const output = JSON.parse(result.stdout);
    return (output.diagnostics ?? [])
      .map((diagnostic) => oxlintFinding(repoRoot, diagnostic))
      .filter((finding) => finding.ruleId === testCase.ruleId);
  } catch {
    return [
      {
        ruleId: null,
        message:
          result.stderr.trim() ||
          result.stdout.trim() ||
          `Oxlint exited with status ${result.status}.`,
      },
    ];
  }
}

async function lintCase(repoRoot, testCase, corpusLabel) {
  const absolutePaths = testCase.paths.map((path) => resolve(repoRoot, path));
  const typeAwareProject = typeAwareProjectFor(testCase);
  const programFiles = programFilesFor(repoRoot, testCase);
  const requiredPaths = typeAwareProject
    ? [...absolutePaths, resolve(repoRoot, typeAwareProject), ...programFiles]
    : [...absolutePaths, ...programFiles];
  const missingFiles = requiredPaths
    .filter((path) => !existsSync(path))
    .map((path) => relativeFile(repoRoot, path));
  if (missingFiles.length > 0) {
    return {
      id: testCase.id,
      ruleId: testCase.ruleId,
      kind: testCase.kind,
      classification: testCase.classification,
      subproject: testCase.subproject,
      paths: testCase.paths,
      findings: [],
      missingFiles,
      decision: "fail",
      reason: `Missing ${corpusLabel} files: ${missingFiles.join(", ")}`,
    };
  }

  if (testCase.runtime === "oxlint") {
    const findings = lintOxlintCase(repoRoot, testCase);
    return {
      id: testCase.id,
      ruleId: testCase.ruleId,
      runtime: testCase.runtime,
      kind: testCase.kind,
      classification: testCase.classification,
      subproject: testCase.subproject,
      paths: testCase.paths,
      findings,
      missingFiles,
      ...evaluateCase(testCase, findings, missingFiles, corpusLabel),
    };
  }

  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,js,jsx}"],
        ignores: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/gen/**",
        ],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 2023,
          sourceType: "module",
          parserOptions: parserOptionsFor(repoRoot, testCase),
        },
        plugins: {
          antidrift: plugin,
          "@eslint-community/eslint-comments": eslintComments,
        },
        rules: { [testCase.ruleId]: ruleValueFor(testCase) },
      },
      ...(testCase.extraOverrideConfig ?? []),
    ],
  });

  const results = await eslint.lintFiles(absolutePaths);
  const findings = results.flatMap((result) =>
    result.messages
      .filter(
        (message) =>
          message.ruleId === testCase.ruleId || message.ruleId == null
      )
      .map((message) => ({
        path: relativeFile(repoRoot, result.filePath),
        ruleId: message.ruleId,
        line: message.line,
        column: message.column,
        message: message.message,
      }))
  );
  const evaluation = evaluateCase(
    testCase,
    findings,
    missingFiles,
    corpusLabel
  );

  return {
    id: testCase.id,
    ruleId: testCase.ruleId,
    kind: testCase.kind,
    classification: testCase.classification,
    subproject: testCase.subproject,
    paths: testCase.paths,
    findings,
    missingFiles,
    ...evaluation,
  };
}

export async function runCorpusCases({
  corpus = "corpus",
  corpusLabel = corpus,
  repoCandidates = [],
  repo = null,
  slice = `${corpus}-corpus`,
  output = null,
  require = false,
  rules = null,
  cases = [],
  report = console.log,
} = {}) {
  const repoRoot = findRepoRoot(repo, repoCandidates);
  if (!repoRoot) {
    const summary = {
      schemaVersion: 1,
      corpus,
      slice,
      decision: require ? "fail" : "skip",
      reason: `${corpusLabel} repo not found. Pass --repo or set the matching environment variable.`,
      cases: [],
    };
    report(JSON.stringify(summary, null, 2));
    return summary;
  }

  const selectedCases = rules
    ? cases.filter((testCase) => rules.includes(testCase.ruleId))
    : cases;
  if (selectedCases.length === 0) {
    const summary = {
      schemaVersion: 1,
      corpus,
      slice,
      repoRoot,
      decision: require ? "fail" : "skip",
      reason: "No corpus cases matched the requested rules.",
      rules: [],
      cases: [],
    };
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (output) {
      writeFileSync(resolve(output), json, "utf8");
    } else {
      report(json.trimEnd());
    }
    return summary;
  }
  const results = await Promise.all(
    selectedCases.map((testCase) => lintCase(repoRoot, testCase, corpusLabel))
  );

  const summary = {
    schemaVersion: 1,
    corpus,
    slice,
    repoRoot,
    decision: results.some((result) => result.decision === "fail")
      ? "fail"
      : "pass",
    rules: [...new Set(selectedCases.map((testCase) => testCase.ruleId))],
    cases: results,
  };
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) {
    writeFileSync(resolve(output), json, "utf8");
  } else {
    report(json.trimEnd());
  }
  return summary;
}
