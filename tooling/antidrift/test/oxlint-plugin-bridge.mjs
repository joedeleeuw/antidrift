import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ADDON_LIBRARY_NAMES,
  loadNativeAddon,
  resolveOxlintBinary,
} from "../src/policy/oxlint.mjs";
import {
  PLUGIN_TEST_SOURCES,
  proveDirectAddonAndCreate,
  proveTypeAwareRelay,
} from "./oxlint-plugin-relay.mjs";

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
    process.execPath,
    [
      resolveOxlintBinary(),
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
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "antidrift-oxlint-plugin-"))
  );
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify(TSCONFIG));
  for (const [file, text] of Object.entries(PLUGIN_TEST_SOURCES)) {
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

const PROPS_RULE = "antidrift/react-max-component-props";
const PROPS_FILE = "src/card.tsx";

function runPropsRule({ repoRoot, project, setting, label }) {
  const configPath = join(project, `oxlintrc.props-${label}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [
        resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
      ],
      categories: { correctness: "off" },
      rules: { [PROPS_RULE]: setting },
    })
  );
  return spawnSync(
    process.execPath,
    [resolveOxlintBinary(), "-c", configPath, "--format", "json", PROPS_FILE],
    { cwd: project, encoding: "utf8" }
  );
}

function proveRuleOptions(repoRoot, project) {
  const strict = runPropsRule({
    repoRoot,
    project,
    setting: ["error", { max: 2 }],
    label: "strict",
  });
  assert.deepEqual(
    [strict.status, summarize(JSON.parse(strict.stdout).diagnostics)],
    [1, [[PROPS_FILE, "antidrift(react-max-component-props)", "error", 1]]],
    `rule options reach the engine through the plugin: max 2 must report the three-prop component, got ${strict.stderr}`
  );
  const defaults = runPropsRule({
    repoRoot,
    project,
    setting: "error",
    label: "default",
  });
  assert.deepEqual(
    [defaults.status, summarize(JSON.parse(defaults.stdout).diagnostics)],
    [0, []],
    `without options the shipped default (12) keeps the component clean, got ${defaults.stderr}`
  );
  const unknown = runPropsRule({
    repoRoot,
    project,
    setting: ["error", { maximum: 2 }],
    label: "unknown",
  });
  assert.ok(
    unknown.status !== 0 &&
      `${unknown.stdout}${unknown.stderr}`.includes("maximum"),
    `an unknown option must fail the run naming the field, got status ${unknown.status}: ${unknown.stderr}`
  );
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

function proveLineSeparatorRange(repoRoot, project) {
  const plainSource =
    'export const label = "ab";\nexport const value = (1 as unknown) as never;\n';
  const sepSource =
    'export const label = "a\u2028b";\nexport const value = (1 as unknown) as never;\n';
  writeFileSync(join(project, "src/plain.ts"), plainSource);
  writeFileSync(join(project, "src/sep.ts"), sepSource);
  const run = runOxlint({
    repoRoot,
    project,
    level: "error",
    files: ["src/plain.ts", "src/sep.ts"],
  });
  const byFile = new Map(
    run.diagnostics.map((diag) => [diag.filename, diag.labels[0]?.span])
  );
  const castExpr = "(1 as unknown) as never";
  assert.equal(
    byFile.get("src/plain.ts")?.offset,
    Buffer.byteLength(plainSource.slice(0, plainSource.indexOf(castExpr)))
  );
  assert.equal(
    byFile.get("src/sep.ts")?.offset,
    Buffer.byteLength(sepSource.slice(0, sepSource.indexOf(castExpr)))
  );
  rmSync(join(project, "src/plain.ts"));
  rmSync(join(project, "src/sep.ts"));
}

function runLineCapOxlint(repoRoot, project, file) {
  const configPath = join(project, "oxlintrc.line-cap.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [
        resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
      ],
      categories: { correctness: "off" },
      rules: {
        "antidrift/max-module-lines": "error",
        "antidrift/max-module-lines-near": "warn",
      },
    })
  );
  const run = spawnSync(
    process.execPath,
    [resolveOxlintBinary(), "-c", configPath, "--format", "json", file],
    { cwd: project, encoding: "utf8" }
  );
  return [run.status, summarize(JSON.parse(run.stdout).diagnostics)];
}

function proveLineCapNearWarning(repoRoot, project) {
  const lines = (count) =>
    `${Array.from({ length: count }, (_, idx) => `export const c${idx} = ${idx};`).join("\n")}\n`;
  writeFileSync(join(project, "src/near.ts"), lines(450));
  writeFileSync(join(project, "src/over.ts"), lines(501));
  assert.deepEqual(runLineCapOxlint(repoRoot, project, "src/near.ts"), [
    0,
    [["src/near.ts", "antidrift(max-module-lines-near)", "warning", 1]],
  ]);
  assert.deepEqual(runLineCapOxlint(repoRoot, project, "src/over.ts"), [
    1,
    [["src/over.ts", "antidrift(max-module-lines)", "error", 1]],
  ]);
  const addon = loadNativeAddon();
  const nearExcluded = {
    rule: "antidrift/max-module-lines-near",
    options: JSON.stringify([{ excludeFiles: ["src/**"] }]),
  };
  const baseRule = { rule: "antidrift/max-module-lines" };
  const overPath = join(project, "src/over.ts");
  assert.deepEqual(
    addon.lintFile(project, overPath, [nearExcluded, baseRule]),
    addon.lintFile(project, overPath, [baseRule, nearExcluded])
  );
  rmSync(join(project, "src/near.ts"));
  rmSync(join(project, "src/over.ts"));
}

const FIXABLE_FILE = "src/fixable.ts";

function proveFixAfterRegularPass(repoRoot, project, linter) {
  writeFileSync(
    join(project, FIXABLE_FILE),
    "let answer = { key: 1 };\nexport const value = answer.key as number;\n"
  );
  const configPath = join(project, "oxlintrc.fix.json");
  const jsPlugins = [
    resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
  ];
  const rules = {
    "prefer-const": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    "antidrift/no-as-never": "error",
  };
  writeFileSync(
    configPath,
    JSON.stringify({ jsPlugins, categories: { correctness: "off" }, rules })
  );
  const args = [
    resolveOxlintBinary(),
    "-c",
    configPath,
    "--type-aware",
    "--fix",
    FIXABLE_FILE,
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, OXLINT_TSGOLINT_PATH: linter },
  });
  assert.equal(
    readFileSync(join(project, FIXABLE_FILE), "utf8"),
    "const answer = { key: 1 };\nexport const value = answer.key;\n",
    `Typed fixes must apply to the text the regular pass left: ${run.stdout}${run.stderr}`
  );
  rmSync(join(project, FIXABLE_FILE));
}

export async function proveOxlintPluginBridge(repoRoot, linter) {
  execFileSync(
    "cargo",
    ["build", "--locked", "-p", "antidrift-napi", "--quiet"],
    {
      cwd: repoRoot,
      stdio: "inherit",
    }
  );
  process.env.ANTIDRIFT_NAPI_ADDON = resolve(
    repoRoot,
    "target/debug",
    ADDON_LIBRARY_NAMES[process.platform]
  );
  process.env.ANTIDRIFT_LINTER_BIN = linter;
  const project = writeProject();
  try {
    proveConfiguredLevels(repoRoot, project);
    proveRuleOptions(repoRoot, project);
    proveIdleDirective(repoRoot, project);
    proveLineSeparatorRange(repoRoot, project);
    await proveTypeAwareRelay(repoRoot, project, linter);
    proveFixAfterRegularPass(repoRoot, project, linter);
    await proveDirectAddonAndCreate(project, linter);
    proveLineCapNearWarning(repoRoot, project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
