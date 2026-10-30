import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadNativeAddon } from "../src/policy/oxlint.mjs";

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
    noEmit: true,
  },
  include: ["src"],
};

const SOURCES = {
  "src/cast.ts":
    "export function castAway(value: unknown) {\n  return value as never;\n}\n\n" +
    "// oxlint-disable-next-line antidrift/no-as-never -- the bridge must count this directive as used\n" +
    "export const suppressed = (1 as unknown) as never;\n",
  "src/other.ts": 'export const other = ("x" as unknown) as never;\n',
  "src/idle-directive.ts":
    "// oxlint-disable-next-line antidrift/no-as-never -- nothing here to suppress\n" +
    "export const clean = 1;\n",
};

function runOxlint({ repoRoot, project, level, files }) {
  const configPath = join(project, `oxlintrc.${level}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [
        resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
      ],
      categories: { correctness: "off" },
      rules: { "antidrift/no-as-never": level },
    })
  );
  const run = spawnSync(
    resolve(repoRoot, "node_modules/.bin/oxlint"),
    [
      "-c",
      configPath,
      "--format",
      "json",
      "--report-unused-disable-directives-severity",
      "error",
      ...files,
    ],
    { cwd: project, encoding: "utf8" }
  );
  return {
    status: run.status,
    diagnostics: JSON.parse(run.stdout).diagnostics,
  };
}

function summarize(diagnostics) {
  return diagnostics
    .map((diagnostic) => [
      diagnostic.filename,
      diagnostic.code,
      diagnostic.severity,
      diagnostic.labels[0]?.span.line,
    ])
    .sort((left, right) => String(left).localeCompare(String(right)));
}

const CAST_FILES = ["src/cast.ts", "src/other.ts"];
const RULE_CODE = "antidrift(no-as-never)";
const LEVEL_CASES = [
  { level: "warn", status: 0, severity: "warning" },
  { level: "error", status: 1, severity: "error" },
];

function writeProject() {
  const project = mkdtempSync(join(tmpdir(), "antidrift-oxlint-plugin-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify(TSCONFIG));
  for (const [file, text] of Object.entries(SOURCES)) {
    writeFileSync(join(project, file), text);
  }
  return project;
}

function proveConfiguredLevels(repoRoot, project) {
  for (const { level, status, severity } of LEVEL_CASES) {
    const run = runOxlint({ repoRoot, project, level, files: CAST_FILES });
    assert.deepEqual(
      [run.status, summarize(run.diagnostics)],
      [
        status,
        [
          ["src/cast.ts", RULE_CODE, severity, 2],
          ["src/other.ts", RULE_CODE, severity, 1],
        ],
      ],
      `antidrift/no-as-never at ${level} must report ${severity}s, exit ${status}, and count its honored disable comment as used`
    );
  }
}

function proveIdleDirective(repoRoot, project) {
  const idle = runOxlint({
    repoRoot,
    project,
    level: "warn",
    files: ["src/idle-directive.ts"],
  });
  assert.equal(
    idle.status,
    1,
    "An idle antidrift disable comment must fail the run"
  );
  assert.match(
    idle.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    /Unused oxlint-disable directive/u
  );
}

export function proveOxlintPluginBridge(repoRoot) {
  execFileSync(
    "cargo",
    ["build", "--locked", "-p", "antidrift-napi", "--quiet"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    }
  );
  const project = writeProject();
  try {
    proveConfiguredLevels(repoRoot, project);
    proveIdleDirective(repoRoot, project);
    const addon = loadNativeAddon(project);
    for (const file of CAST_FILES) {
      addon.lintFile(project, join(project, file));
    }
    assert.equal(
      addon.programsBuilt(),
      1,
      "Two files under one tsconfig must share one type program"
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
