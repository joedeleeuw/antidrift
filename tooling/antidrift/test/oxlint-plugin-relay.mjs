import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadNativeAddon } from "../src/policy/oxlint.mjs";

const CAST_FILES = ["src/cast.ts", "src/other.ts"];
const RULE_CODE = "antidrift(no-as-never)";
export const PLUGIN_TEST_SOURCES = {
  "src/cast.ts":
    "export function castAway(value: unknown) {\n  return value as never;\n}\n\n" +
    "// oxlint-disable-next-line antidrift/no-as-never -- the bridge must count this directive as used\n" +
    "export const suppressed = (1 as unknown) as never;\n",
  "src/other.ts": 'export const other = ("x" as unknown) as never;\n',
  "src/idle-directive.ts":
    "// oxlint-disable-next-line antidrift/no-as-never -- nothing here to suppress\n" +
    "export const clean = 1;\n",
  "src/floating.ts": "export async function work() {}\n\nwork();\n",
  "src/api.d.ts": "export declare function read(): void;\n",
  "src/card.tsx":
    "export function Card(props: { title: string; body: string; footer: string }) {\n  return <article>{props.title}{props.body}{props.footer}</article>;\n}\n",
  "src/caller.ts": 'import { read } from "./api";\n\nread();\n',
};
const RELAYED_FILES = [
  "src/cast.ts",
  "src/other.ts",
  "src/floating.ts",
  "src/caller.ts",
];
const STALE_ENGINE = "127.0.0.1:9/stale-token";
const EDITED_OTHER_SOURCE =
  'export const other = ("x" as unknown) as never;\nexport const again = ("y" as unknown) as never;\n';

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

function decodeHeadless(output) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= output.length) {
    const length = output.readUInt32LE(offset);
    messages.push([
      output.readUInt8(offset + 4),
      output.subarray(offset + 5, offset + 5 + length).toString("utf8"),
    ]);
    offset += 5 + length;
  }
  return messages.map((message) => JSON.stringify(message)).sort();
}

function headlessPayload(project, sourceOverrides) {
  return JSON.stringify({
    version: 2,
    configs: [
      {
        file_paths: RELAYED_FILES.map((file) => join(project, file)),
        rules: [
          { name: "antidrift/no-as-never" },
          { name: "no-floating-promises" },
        ],
      },
    ],
    ...(sourceOverrides ? { source_overrides: sourceOverrides } : {}),
  });
}

function runHeadless({ linter, cwd, payload, environment }) {
  const run = spawnSync(linter, ["headless"], {
    cwd,
    env: environment,
    input: payload,
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return decodeHeadless(run.stdout);
}

const RELAY_CASES = [
  {
    name: "a fresh program",
    cwd: (project) => project,
    overrides: () => undefined,
    edit: () => {},
    reused: 1,
  },
  {
    name: "a payload with source overrides",
    cwd: (project) => project,
    overrides: (project) => ({
      [join(project, "src/other.ts")]: EDITED_OTHER_SOURCE,
    }),
    edit: () => {},
    reused: 0,
  },
  {
    name: "a directory with no plugin session",
    cwd: (project) => join(project, "src"),
    overrides: () => undefined,
    edit: () => {},
    reused: 0,
  },
  {
    name: "a file changed on disk since the plugin pass",
    cwd: (project) => project,
    overrides: () => undefined,
    edit: (project) =>
      writeFileSync(join(project, "src/other.ts"), EDITED_OTHER_SOURCE),
    reused: 0,
  },
  {
    name: "a declaration file changed on disk since the plugin pass",
    cwd: (project) => project,
    overrides: () => undefined,
    edit: (project) =>
      writeFileSync(
        join(project, "src/api.d.ts"),
        "export declare function read(): Promise<void>;\n"
      ),
    reused: 0,
  },
];

function restoreSources(project) {
  for (const [file, text] of Object.entries(PLUGIN_TEST_SOURCES)) {
    writeFileSync(join(project, file), text);
  }
}

function proveRelay(linter, project, addon) {
  const { ANTIDRIFT_ENGINE: _inherited, ...environment } = process.env;
  for (const relayCase of RELAY_CASES) {
    relayCase.edit(project);
    const request = {
      linter,
      cwd: relayCase.cwd(project),
      payload: headlessPayload(project, relayCase.overrides(project)),
    };
    const alone = runHeadless({ ...request, environment });
    const before = addon.engineStats();
    const relayed = runHeadless({
      ...request,
      environment: { ...environment, ANTIDRIFT_ENGINE: addon.engineEndpoint() },
    });
    const after = addon.engineStats();
    assert.ok(
      alone.length >= 3,
      `The headless helper must report the planted findings for ${relayCase.name}: ${alone}`
    );
    assert.deepEqual(
      relayed,
      alone,
      `A relayed request for ${relayCase.name} must answer exactly as the helper does alone`
    );
    assert.deepEqual(
      [
        after.programsBuilt - before.programsBuilt,
        after.programsReused - before.programsReused,
        after.relayedRequests - before.relayedRequests,
      ],
      [0, relayCase.reused, 1],
      `A relayed request for ${relayCase.name} must build nothing in the engine and reuse ${relayCase.reused} program`
    );
    restoreSources(project);
  }
}

function runTypeAwareOxlint({ repoRoot, project, linter, plugin }) {
  const configPath = join(project, `oxlintrc.type-aware.${plugin}.json`);
  const pluginConfig = plugin
    ? {
        jsPlugins: [
          resolve(repoRoot, "tooling/antidrift/src/oxlint-plugin/index.mjs"),
        ],
      }
    : {};
  writeFileSync(
    configPath,
    JSON.stringify({
      ...pluginConfig,
      categories: { correctness: "off" },
      rules: {
        "typescript/no-floating-promises": "error",
        ...(plugin ? { "antidrift/no-as-never": "error" } : {}),
      },
    })
  );
  const run = spawnSync(
    resolve(repoRoot, "node_modules/.bin/oxlint"),
    ["-c", configPath, "--type-aware", "--format", "json", ...RELAYED_FILES],
    {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        OXLINT_TSGOLINT_PATH: linter,
        ANTIDRIFT_ENGINE: STALE_ENGINE,
      },
    }
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

export function proveTypeAwareRelay(repoRoot, project, linter) {
  const withPlugin = runTypeAwareOxlint({
    repoRoot,
    project,
    linter,
    plugin: true,
  });
  assert.deepEqual(
    [withPlugin.status, summarize(JSON.parse(withPlugin.output).diagnostics)],
    [
      1,
      [
        ["src/cast.ts", RULE_CODE, "error", 2],
        ["src/floating.ts", "typescript(no-floating-promises)", "error", 3],
        ["src/other.ts", RULE_CODE, "error", 1],
      ],
    ],
    `Loading the plugin must point the type-aware helper at its own engine: ${withPlugin.output}`
  );
  const withoutPlugin = runTypeAwareOxlint({
    repoRoot,
    project,
    linter,
    plugin: false,
  });
  assert.notEqual(withoutPlugin.status, 0, withoutPlugin.output);
  assert.match(
    withoutPlugin.output,
    /antidrift engine relay named by ANTIDRIFT_ENGINE \(127\.0\.0\.1:9\/stale-token\) failed/u,
    "The type-aware helper must fail loudly on an engine it cannot reach"
  );
}

export async function proveDirectAddonAndCreate(project, linter) {
  const { default: antidriftPlugin } =
    await import("../src/oxlint-plugin/index.mjs");
  const findings = [];
  const castFile = join(project, CAST_FILES[0]);
  const rule = antidriftPlugin.rules["no-as-never"];
  const visitor = rule.create({
    cwd: project,
    filename: castFile,
    options: [],
    report(finding) {
      findings.push(finding.loc.start.line);
    },
  });
  visitor.Program();
  assert.deepEqual(
    findings,
    [2, 6],
    "The standard ESLint/Bun create(context) visitor must report findings through Program()"
  );

  const addon = loadNativeAddon(project);
  assert.deepEqual(
    addon.lintFile(project, join(project, CAST_FILES[0]), []),
    [],
    "A lint request with no rules must report nothing"
  );
  for (const file of CAST_FILES) {
    addon.lintFile(project, join(project, file), [
      { rule: "antidrift/no-as-never" },
    ]);
  }
  assert.equal(
    addon.engineStats().programsBuilt,
    1,
    "Two files under one tsconfig must share one type program"
  );
  proveRelay(linter, project, addon);
}
