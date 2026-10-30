import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { buildBoundaryProbes } from "./boundary-probes.mjs";
import {
  buildSharedHelperFiles,
  coreHeadlessProbes,
  portableCases,
} from "./portable-cases.mjs";
import { headlessRuleProbes } from "./headless-rule-probes.mjs";
import { proveOxlintPluginBridge } from "./oxlint-plugin-bridge.mjs";
import { loadPolicy } from "../src/policy/generate-policy-artifacts.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const binaryPath = resolve(repoRoot, "target/debug/antidrift-linter");

execFileSync("cargo", ["build", "--bin", "antidrift-linter", "--quiet"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const registeredRulesOutput = execFileSync(binaryPath, ["--list-rules"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const registeredRules = new Set(
  registeredRulesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
);

const batchRuleIds = new Set(
  portableCases.map((entry) => `antidrift/${entry.name}`)
);
const batchInputs = [];
const expectations = new Map();
const sourceWorkspace = mkdtempSync(join(tmpdir(), "antidrift-rust-source-"));
process.on("exit", () =>
  rmSync(sourceWorkspace, { recursive: true, force: true })
);
for (const [directory, manifest] of [
  [
    "apps/client",
    { name: "@homer/client", dependencies: { "@homer/shared": "workspace:*" } },
  ],
  ["apps/other", { name: "@homer/other" }],
  ["packages/shared", { name: "@homer/shared" }],
]) {
  mkdirSync(join(sourceWorkspace, directory, "src"), { recursive: true });
  writeFileSync(
    join(sourceWorkspace, directory, "package.json"),
    JSON.stringify(manifest)
  );
}

for (const entry of portableCases) {
  const fullRuleId = `antidrift/${entry.name}`;
  if (!batchRuleIds.has(fullRuleId)) {
    continue;
  }
  const caseId = entry.caseId ?? entry.name;
  const invalidId = `${caseId}:invalid`;
  const validId = `${caseId}:valid`;
  const invalidFilename = join(
    sourceWorkspace,
    entry.filename ?? "component.tsx"
  );
  const validFilename = join(
    sourceWorkspace,
    entry.validFilename ?? entry.filename ?? "component.tsx"
  );

  batchInputs.push({
    id: invalidId,
    filename: invalidFilename,
    sourceText: entry.invalid,
    rule: fullRuleId,
    options: entry.options ?? null,
  });
  expectations.set(invalidId, {
    ruleId: fullRuleId,
    expectedCount: entry.occurrences ?? 1,
  });

  batchInputs.push({
    id: validId,
    filename: validFilename,
    sourceText: entry.valid,
    rule: fullRuleId,
    options: entry.validOptions ?? entry.options ?? null,
  });
  expectations.set(validId, {
    ruleId: fullRuleId,
    expectedCount: 0,
  });
}

writeFileSync(
  join(sourceWorkspace, "states.ts"),
  'export const states = ["ready", "done"] as const;\n'
);

const boundaryProbes = buildBoundaryProbes(sourceWorkspace, join);
for (const { expectedCount, filename, ...probe } of boundaryProbes) {
  batchInputs.push({
    ...probe,
    filename: filename ?? join(sourceWorkspace, "boundary.ts"),
  });
  expectations.set(probe.id, { ruleId: probe.rule, expectedCount });
}

const rawBatchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
  cwd: repoRoot,
  input: JSON.stringify(
    batchInputs.map((input) => ({ cwd: sourceWorkspace, ...input }))
  ),
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const batchResults = JSON.parse(String(rawBatchOutput));
assert.equal(batchResults.length, batchInputs.length);

for (const outcome of batchResults) {
  const expected = expectations.get(outcome.id);
  assert.ok(expected, `Missing expectation for ${outcome.id}`);
  assert.equal(
    outcome.diagnostics.length,
    expected.expectedCount,
    `Case ${outcome.id} expected ${expected.expectedCount} diagnostics, got ${JSON.stringify(outcome.diagnostics)}`
  );
  for (const diag of outcome.diagnostics) {
    assert.equal(diag.ruleId, expected.ruleId);
  }
}

function runHeadlessProbe(payload, extraEnv = {}) {
  const proc = spawnSync(binaryPath, ["headless"], {
    cwd: repoRoot,
    input: Buffer.from(JSON.stringify(payload), "utf8"),
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    encoding: "buffer",
  });
  const buf = proc.stdout;
  const diagnostics = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const kind = buf.readUInt8(offset + 4);
    const payloadText = buf
      .subarray(offset + 5, offset + 5 + length)
      .toString("utf8");
    offset += 5 + length;
    if (kind === 1) {
      diagnostics.push(JSON.parse(String(payloadText)));
    } else if (kind === 0) {
      throw new Error(`Headless protocol error: ${payloadText}`);
    }
  }
  if (proc.status !== 0) {
    throw new Error(
      `Headless process exited with ${proc.status}: ${(proc.stderr ?? Buffer.alloc(0)).toString("utf8")}`
    );
  }
  return diagnostics;
}

const probeFileA = resolve(repoRoot, "tooling/antidrift/src/__probe_a.ts");
const probeFileB = resolve(repoRoot, "tooling/antidrift/src/__probe_b.ts");

const headlessProbes = [...coreHeadlessProbes, ...headlessRuleProbes];

const sharedHelperFiles = buildSharedHelperFiles(repoRoot, resolve);

const combinedConfigs = Object.keys(sharedHelperFiles).map((filePath) => ({
  file_paths: [filePath],
  rules: [],
}));
const combinedOverrides = { ...sharedHelperFiles };
const probeFiles = headlessProbes.map((probe, idx) => {
  const filePath = probe.file
    ? resolve(repoRoot, probe.file)
    : resolve(repoRoot, `tooling/antidrift/src/__probe_case_${idx}.ts`);
  combinedConfigs.push({
    file_paths: [filePath],
    rules: [{ name: probe.rule }],
  });
  combinedOverrides[filePath] = probe.source;
  return filePath;
});

const allProbeDiags = runHeadlessProbe({
  version: 2,
  configs: combinedConfigs,
  source_overrides: combinedOverrides,
});

for (const [idx, probe] of headlessProbes.entries()) {
  const filePath = probeFiles[idx];
  const diags = allProbeDiags.filter((diag) => diag.file_path === filePath);
  assert.equal(
    diags.length,
    probe.expectedCount,
    `Headless probe '${probe.name}' expected ${probe.expectedCount} diagnostics, got ${JSON.stringify(diags)}`
  );
}

const loneSurrogateFile = resolve(
  repoRoot,
  "tooling/antidrift/src/__probe_lone_surrogate.tsx"
);
const loneSurrogateSource = [
  'export const lone = "a\\uD83D";',
  "export const tail = 'b\\uDE00 c';",
  "export const plain = `x\\uD83D y`;",
  "export const spans = `h\\uD83D ${lone} m\\uDE00 ${tail} t\\uD800`;",
  'export const keyed = { "\\uD83D": 1, ["\\uDE00"]: 2 };',
  'export const picked = keyed["\\uD83D"];',
  'export function guard(value: unknown) { return typeof value === "\\uD83D"; }',
  'export function fail() { throw new Error("\\uD83D"); }',
  'export function View() { return <div className={"text-foreground/50 \\uD83D"} title="\\uDBFF">{"\\uD800"}</div>; }',
  'export function Valid() { return <div className="text-foreground/50">ok</div>; }',
  "declare const userInput: string;",
  'export const concatQuery = "SELECT * FROM users WHERE name = \'\\uD83D" + userInput + "\'";',
  "export const templateQuery = `SELECT * FROM users WHERE name = '${userInput}' -- \\uD83D`;",
].join("\n");
const loneSurrogateDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [loneSurrogateFile],
      rules: [...registeredRules].map((name) => ({ name })),
    },
  ],
  source_overrides: { [loneSurrogateFile]: loneSurrogateSource },
});
assert.deepEqual(
  loneSurrogateDiags
    .filter((diag) => diag.message.id === "antidrift/no-raw-foreground-opacity")
    .map((diag) => diag.range.pos),
  [loneSurrogateSource.indexOf('"text-foreground/50">ok')],
  `Lone-surrogate literals must lint without aborting and leave the valid className reported, got ${JSON.stringify(loneSurrogateDiags)}`
);
assert.equal(
  loneSurrogateDiags.filter(
    (diag) => diag.message.id === "antidrift/no-sql-string-concat"
  ).length,
  2,
  `A lone surrogate in a SQL fragment must not hide the dynamic input, got ${JSON.stringify(loneSurrogateDiags)}`
);

const sqlDefaultDiags = runHeadlessProbe(
  {
    version: 2,
    configs: [
      {
        file_paths: [probeFileA],
        rules: [{ name: "no-floating-promises" }],
      },
    ],
    source_overrides: {
      [probeFileA]: `
        export function queryUser(userId: string) {
          return \`SELECT id FROM users WHERE id = \${userId}\`;
        }
      `,
    },
  },
  { ANTIDRIFT_TSGOLINT_DEFAULTS: "1" }
);
assert.equal(
  sqlDefaultDiags.filter(
    (diag) => diag.message?.id === "antidrift/no-sql-string-concat"
  ).length,
  1,
  `Expected default native rules to report antidrift/no-sql-string-concat, got ${JSON.stringify(sqlDefaultDiags)}`
);

const perFileIsolationDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [probeFileA],
      rules: [{ name: "antidrift/no-compat-names" }],
    },
    {
      file_paths: [probeFileB],
      rules: [],
    },
  ],
  source_overrides: {
    [probeFileA]: "export const cleanName = 1;\n",
    [probeFileB]: "export const legacyAdapter = 1;\n",
  },
});
assert.equal(
  perFileIsolationDiags.length,
  0,
  `Per-file config isolation failed: ${JSON.stringify(perFileIsolationDiags)}`
);

assert.ok(
  registeredRules.has("antidrift/no-vague-names"),
  "Expected --list-rules to include antidrift/no-vague-names"
);

const coveredRuleIds = new Set([
  ...batchInputs.map((entry) => entry.rule),
  ...headlessProbes.map((probe) => probe.rule),
  "antidrift/no-sql-string-concat",
  "antidrift/max-module-lines",
  "antidrift/max-function-lines",
  "antidrift/max-component-lines",
]);
for (const registeredRule of registeredRules) {
  assert.ok(
    coveredRuleIds.has(registeredRule),
    `Expected registered rule '${registeredRule}' to have smoke coverage in rust-parity.mjs`
  );
}

const emptyFilesScopeDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [probeFileA],
      rules: [{ name: "antidrift/no-compat-names", options: [{ files: [] }] }],
    },
  ],
  source_overrides: {
    [probeFileA]: "export const legacyAdapter = 1;\n",
  },
});
assert.equal(
  emptyFilesScopeDiags.length,
  0,
  `Expected files: [] to match 0 files, got ${JSON.stringify(emptyFilesScopeDiags)}`
);

assert.throws(
  () =>
    runHeadlessProbe({
      version: 2,
      configs: [
        {
          file_paths: [probeFileA],
          rules: [
            {
              name: "antidrift/react-max-component-props",
              options: [{ max: 0 }],
            },
          ],
        },
      ],
      source_overrides: {
        [probeFileA]: "export const x = 1;\n",
      },
    }),
  /max must be >= 1/
);

assert.throws(
  () =>
    runHeadlessProbe({
      version: 2,
      configs: [
        {
          file_paths: [probeFileA],
          rules: [
            {
              name: "antidrift/no-compat-names",
              options: [{ files: ["["] }],
            },
          ],
        },
      ],
      source_overrides: {
        [probeFileA]: "export const x = 1;\n",
      },
    }),
  /invalid glob/
);

const missingPathRun = spawnSync(
  binaryPath,
  ["nonexistent-smoke-target-file.ts"],
  {
    cwd: repoRoot,
    encoding: "utf8",
  }
);
assert.notEqual(
  missingPathRun.status,
  0,
  "Expected missing CLI path to fail with non-zero exit code"
);

const tempWorkspace = mkdtempSync(join(tmpdir(), "antidrift-rust-smoke-"));
try {
  const kernelSrc = join(tempWorkspace, "crates/antidrift-kernel/src");
  mkdirSync(kernelSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-kernel/Cargo.toml"),
    '[package]\nname = "antidrift-kernel"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(kernelSrc, "lib.rs"),
    "pub mod boundary;\npub mod provenance;\n"
  );
  writeFileSync(
    join(kernelSrc, "boundary.rs"),
    "pub struct BoundaryItem;\npub struct WindowBounds { pub x: i32, pub y: i32, pub width: u32 }\npub fn load_raw_manifest() -> serde_json::Value { serde_json::Value::Null }\n"
  );
  writeFileSync(
    join(kernelSrc, "provenance.rs"),
    [
      "use crate::{ boundary::BoundaryItem, boundary::load_raw_manifest };",
      "use serde::Deserialize;",
      "use std::collections::HashMap;",
      "// forbidden inline comment",
      "pub struct FrameBounds { pub x: i32, pub y: i32, pub width: u32 }",
      "#[derive(Deserialize)]",
      "pub struct LooseConfig { pub kind: String, pub exclude_files: Vec<String>, pub seen: HashMap<String, bool>, pub item: Option<BoundaryItem> }",
      "pub fn decode_rule_options(name: &str) -> Result<usize, String> { Ok(name.len()) }",
      "pub fn legacy_adapter(input: &str) -> Result<usize, String> {",
      "    decode_rule_options(input)?;",
      '    input.parse::<usize>().map_err(|_| "parse failed".to_string())',
      "}",
      "pub fn hop_wrapper(input: &str) -> Result<usize, String> { let _ = input; legacy_adapter(input) }",
      "pub struct Holder { pub ident: String }",
      "pub struct ProjectMeta { pub project_id: String, pub project_key: String }",
      "pub struct StatusEnvelope { pub ok: bool, pub count: usize }",
      "pub struct OutcomeBag { pub ok: bool, pub count: usize, pub error: Option<String> }",
      "pub fn make_envelope_a(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n } }",
      "pub fn make_envelope_b(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n + 1 } }",
      "pub fn compare_ident(h: &Holder, val: &serde_json::Value) -> bool {",
      '    let _ = val["k"].as_str();',
      "    let from_helper = load_raw_manifest();",
      '    let _ = from_helper.get("nested").and_then(|v| v.as_u64());',
      '    let _ = h.ident.to_string() == "foo";',
      '    if let Ok(text) = std::fs::read_to_string("foo.txt") { let _ = text.len(); }',
      '    let _ = std::fs::read_to_string("bar.txt").unwrap_or_default();',
      '    let bins = ["dist/bin/tool", "target/release/tool", "target/debug/tool"];',
      "    let _ = bins.iter().find(|p| std::path::Path::new(p).exists());",
      "    let raw_json = serde_json::to_string(&h.ident).unwrap();",
      "    let _ = serde_json::from_str::<LooseConfig>(&raw_json);",
      "    let _ = h.ident.to_string().parse::<u32>();",
      "    let _ = serde_json::from_str::<LooseConfig>(&h.ident).ok();",
      "    match legacy_adapter(&h.ident) { Ok(_) => true, Err(_) => false }",
      "}",
      "pub async fn bad_async_sleep(err: &str, xs: &[Holder], ys: &[Holder]) -> OutcomeBag {",
      "    std::thread::sleep(std::time::Duration::from_millis(10));",
      '    let _ = err.to_string().contains("not found");',
      "    let _ = xs.iter().map(|x| ys.iter().find(|y| y.ident == x.ident)).count();",
      "    let cloned = Holder { ident: xs[0].ident.clone() };",
      "    let _ = cloned.ident.len();",
      "    match legacy_adapter(err) { Ok(v) => OutcomeBag { ok: true, count: v, error: None }, Err(e) => OutcomeBag { ok: false, count: 0, error: Some(e) } }",
      "}",
      "pub async fn serial_reads(h: &Holder) -> usize {",
      "    let first = read_one(h).await;",
      "    let second = read_two(h).await;",
      "    let third = read_three(h).await;",
      "    first + second + third",
      "}",
      "async fn read_one(h: &Holder) -> usize { h.ident.len() }",
      "async fn read_two(h: &Holder) -> usize { h.ident.len() + 1 }",
      "async fn read_three(h: &Holder) -> usize { h.ident.len() + 2 }",
      "pub fn branch_bag(flag: bool, h: &Holder) -> OutcomeBag {",
      "    if flag { OutcomeBag { ok: true, count: 1, error: None } } else { OutcomeBag { ok: false, count: 0, error: Some(h.ident.clone()) } }",
      "}",
      "pub fn sniff_text(text: &str) -> Option<LooseConfig> {",
      "    serde_json::from_str(text).ok()",
      "}",
      "#[cfg(all(test))]\nmod inline_tests {}",
      "",
    ].join("\n")
  );
  writeFileSync(join(kernelSrc, "orphan_file.rs"), "pub fn unused() {}\n");
  writeFileSync(join(kernelSrc, "bad_helpers.rs"), "pub fn helper() {}\n");
  const rulesSrc = join(tempWorkspace, "crates/antidrift-rules/src");
  mkdirSync(rulesSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-rules/Cargo.toml"),
    '[package]\nname = "antidrift-rules"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(rulesSrc, "lib.rs"),
    "pub struct ScopelessRule;\npub trait Rule {}\nimpl Rule for ScopelessRule {}\n"
  );

  const rustSubcmd = spawnSync(binaryPath, ["rust", "--json", tempWorkspace], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    rustSubcmd.status,
    1,
    `Expected antidrift-linter rust to exit 1 on violations, got ${rustSubcmd.status}: ${rustSubcmd.stderr}`
  );
  const rustDiags = JSON.parse(String(rustSubcmd.stdout ?? ""));
  const reportedRuleIds = new Set(rustDiags.map((diag) => diag.ruleId));
  for (const expectedRuleId of [
    "rust/target-manifest-policy",
    "rust/no-inline-comment",
    "rust/no-layer-violation",
    "rust/require-strict-serde",
    "rust/no-stringly-variant",
    "rust/no-boolean-map",
    "rust/no-orphan-module",
    "rust/no-grab-bag-module",
    "rust/no-anemic-errors",
    "rust/no-compat-names",
    "rust/no-wrapping-functions",
    "rust/no-duplicate-scope-fields",
    "rust/no-discarded-decoded-config",
    "rust/no-let-underscore-suppression",
    "rust/no-ident-to-string-compare",
    "rust/no-untyped-config-probe",
    "rust/no-inline-tests",
    "rust/no-silent-result-discard",
    "rust/require-rule-scope",
    "rust/no-structural-type-fork",
    "rust/no-value-roundtrip",
    "rust/no-decode-to-option",
    "rust/no-constant-return-field",
    "rust/no-redundant-owner-prefix",
    "rust/no-hollow-module",
    "rust/no-blocking-in-async",
    "rust/no-query-join-or-tree-reshape",
    "rust/no-contract-appeasement-projection",
  ]) {
    assert.ok(
      reportedRuleIds.has(expectedRuleId),
      `Expected antidrift-linter rust to report ${expectedRuleId}, got ${JSON.stringify(rustDiags)}`
    );
  }
  for (const expectedMessage of [
    'collapsed into "" via fallback',
    "Do not serialize and deserialize the same value",
    "wall-clock sleep 'std::thread::sleep' inside an async context",
    "Three or more independent reads are awaited one after another",
    "Nested '.find(...)' performs an O(N*M)",
    "spans multiple build output tiers",
    "Untyped config probe '.as_u64()'",
  ]) {
    assert.equal(
      rustDiags.filter((diag) => String(diag.message).includes(expectedMessage))
        .length,
      1,
      `Expected antidrift-linter rust diagnostics to include '${expectedMessage}', got ${JSON.stringify(rustDiags)}`
    );
  }
  assert.equal(
    rustDiags.filter((diag) =>
      String(diag.message).startsWith("Success and failure arms")
    ).length,
    2,
    `Expected the match and if/else outcome bags to each report once, got ${JSON.stringify(rustDiags)}`
  );
  assert.equal(
    rustDiags.filter((diag) => diag.ruleId === "rust/no-decode-to-option")
      .length,
    1,
    `Expected one decode-to-option report for the .ok() discard and none for the sniffed text input, got ${JSON.stringify(rustDiags)}`
  );
  const singleRsRun = spawnSync(
    binaryPath,
    ["rust", "crates/antidrift-linter/src/main.rs"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );
  assert.equal(
    singleRsRun.status,
    0,
    `Expected single-file rust target to exit 0, got ${singleRsRun.status}: ${singleRsRun.stderr}`
  );
} finally {
  rmSync(tempWorkspace, { recursive: true, force: true });
}

const policyRowsSchema = z.object({
  clusters: z.array(
    z.object({
      rules: z.array(
        z.object({ id: z.string(), detector: z.string().optional() })
      ),
    })
  ),
});
const lineCapDiagnosticsSchema = z.array(
  z.object({ ruleId: z.string(), severity: z.string() })
);
const lineCapBatchSchema = z.array(
  z.object({ id: z.string(), diagnostics: lineCapDiagnosticsSchema })
);
const lineCapDetector =
  /^(antidrift|antidrift-linter):([^,]+),warnAt:(\d+),max:(\d+)$/u;
const lineCapShapes = {
  "rust/max-file-lines": {
    head: [],
    tail: [],
    line: (index) => `pub const C_${index}: usize = ${index};`,
  },
  "antidrift/max-module-lines": {
    head: [],
    tail: [],
    line: (index) => `export const c${index} = ${index};`,
  },
  "antidrift/max-function-lines": {
    head: ["export function probe() {"],
    tail: ["}"],
    line: (index) => `  const v${index} = ${index};`,
  },
  "antidrift/max-component-lines": {
    head: ["export function Probe() {"],
    tail: ["  return <div />;", "}"],
    line: (index) => `  const v${index} = ${index};`,
  },
};
function lineCapSource(ruleId, count) {
  const { head, tail, line } = lineCapShapes[ruleId];
  const body = Array.from(
    { length: count - head.length - tail.length },
    (_, index) => line(index)
  );
  return `${[...head, ...body, ...tail].join("\n")}\n`;
}
const lineCaps = policyRowsSchema
  .parse(await loadPolicy(resolve(repoRoot, "policy/agent-guardrails.yaml")))
  .clusters.flatMap(({ rules }) => rules)
  .flatMap(({ detector }) => {
    const match = lineCapDetector.exec(detector ?? "");
    if (!match) {
      return [];
    }
    const [, tool, rule, warnAt, max] = match;
    return [
      {
        ruleId: tool === "antidrift" ? `antidrift/${rule}` : rule,
        warnAt: Number(warnAt),
        max: Number(max),
      },
    ];
  });
assert.deepEqual(
  lineCaps.map(({ ruleId }) => ruleId).sort(),
  Object.keys(lineCapShapes).sort(),
  "policy/agent-guardrails.yaml must declare warnAt and max for every line-cap unit"
);
const lineCapBoundaries = ({ warnAt, max }) => [
  [warnAt, []],
  [warnAt + 1, ["warn"]],
  [max, ["warn"]],
  [max + 1, ["error"]],
];
const lineCapWorkspace = mkdtempSync(join(tmpdir(), "antidrift-line-caps-"));
try {
  const scriptCases = lineCaps
    .filter(({ ruleId }) => ruleId.startsWith("antidrift/"))
    .flatMap((cap) =>
      lineCapBoundaries(cap).map(([count, expected]) => ({
        id: `${cap.ruleId}:${count}`,
        cap,
        count,
        expected,
      }))
    );
  const scriptResults = new Map(
    lineCapBatchSchema
      .parse(
        JSON.parse(
          execFileSync(binaryPath, ["--batch-json", "-"], {
            cwd: repoRoot,
            input: JSON.stringify(
              scriptCases.map(({ id, cap, count }) => ({
                id,
                filename: join(
                  lineCapWorkspace,
                  `${cap.ruleId.replace("antidrift/", "")}-${count}.tsx`
                ),
                cwd: lineCapWorkspace,
                sourceText: lineCapSource(cap.ruleId, count),
                rules: { [cap.ruleId]: "error" },
              }))
            ),
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          })
        )
      )
      .map(({ id, diagnostics }) => [id, diagnostics])
  );
  for (const { id, cap, expected } of scriptCases) {
    assert.deepEqual(
      (scriptResults.get(id) ?? [])
        .filter(({ ruleId }) => ruleId === cap.ruleId)
        .map(({ severity }) => severity),
      expected,
      `${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(scriptResults.get(id))}`
    );
  }
  const rustCap = lineCaps.find(
    ({ ruleId }) => ruleId === "rust/max-file-lines"
  );
  assert.ok(rustCap, "policy must declare rust/max-file-lines");
  for (const [count, expected] of lineCapBoundaries(rustCap)) {
    const rustFile = join(lineCapWorkspace, `cap_${count}.rs`);
    writeFileSync(rustFile, lineCapSource(rustCap.ruleId, count));
    const rustRun = spawnSync(binaryPath, ["rust", "--json", rustFile], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const rustDiagnostics = JSON.parse(rustRun.stdout);
    assert.deepEqual(
      rustDiagnostics
        .filter(({ ruleId }) => ruleId === rustCap.ruleId)
        .map(({ severity }) => severity),
      expected,
      `rust/max-file-lines at ${count} non-blank lines`
    );
    assert.equal(
      rustRun.status,
      expected.includes("error") ? 1 : 0,
      `rust/max-file-lines at ${count} lines exited ${rustRun.status}`
    );
  }
  const deniedNearCap = spawnSync(
    binaryPath,
    [
      "rust",
      "--json",
      "--deny-warnings",
      join(lineCapWorkspace, `cap_${rustCap.warnAt + 1}.rs`),
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(
    deniedNearCap.status,
    1,
    `Expected a near-cap Rust file to fail under --deny-warnings, got ${deniedNearCap.status}`
  );
  const functionCap = lineCaps.find(
    ({ ruleId }) => ruleId === "antidrift/max-function-lines"
  );
  assert.ok(functionCap, "policy must declare antidrift/max-function-lines");
  const nearFunctionFile = resolve(
    repoRoot,
    "tooling/antidrift/src/__probe_line_cap.ts"
  );
  const nearFunctionDiags = runHeadlessProbe({
    version: 2,
    configs: [
      {
        file_paths: [nearFunctionFile],
        rules: [{ name: functionCap.ruleId }],
      },
    ],
    source_overrides: {
      [nearFunctionFile]: lineCapSource(
        functionCap.ruleId,
        functionCap.warnAt + 1
      ),
    },
  });
  assert.deepEqual(
    nearFunctionDiags.map(({ message }) => message.id),
    [functionCap.ruleId],
    `Expected the headless path to surface one near-cap function, got ${JSON.stringify(nearFunctionDiags)}`
  );
  assert.match(nearFunctionDiags[0].message.description, /warn threshold/u);
} finally {
  rmSync(lineCapWorkspace, { recursive: true, force: true });
}

const projectRootWorkspace = mkdtempSync(
  join(tmpdir(), "antidrift-project-root-")
);
try {
  const hopFindingsUnder = (parentDir) => {
    const repoDir = join(projectRootWorkspace, parentDir, "repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      '{ "compilerOptions": { "strict": true, "module": "esnext", "target": "es2022", "moduleResolution": "bundler" }, "include": ["src"] }\n'
    );
    writeFileSync(
      join(repoDir, "package.json"),
      '{ "name": "project-root-probe", "version": "0.0.0", "type": "module", "private": true }\n'
    );
    writeFileSync(
      join(repoDir, "src/owner.ts"),
      "export function loadAccount(accountId: string): string {\n  return accountId.toUpperCase();\n}\n"
    );
    writeFileSync(
      join(repoDir, "src/hop.ts"),
      'import { loadAccount } from "./owner";\n\nfunction fetchAccount(accountId: string): string {\n  return loadAccount(accountId);\n}\n\nexport function render(accountId: string): string {\n  return fetchAccount(accountId);\n}\n'
    );
    const run = spawnSync(binaryPath, ["--format", "json", "src"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    return JSON.parse(String(run.stdout ?? "[]"))
      .flatMap((entry) =>
        entry.messages.map(
          (message) =>
            `${entry.filePath.split("/").pop()}:${message.line} ${message.ruleId}`
        )
      )
      .sort();
  };
  const plainFindings = hopFindingsUnder("plain");
  assert.deepEqual(plainFindings, [
    "hop.ts:3 antidrift/no-pass-through-parameters",
    "hop.ts:3 antidrift/no-wrapping-functions",
    "hop.ts:7 antidrift/no-pass-through-parameters",
    "owner.ts:1 antidrift/no-wrapping-functions",
  ]);
  for (const ancestor of ["build", "dist", "gen", "tests", "fixtures"]) {
    assert.deepEqual(
      hopFindingsUnder(ancestor),
      plainFindings,
      `A repository under a '${ancestor}' directory must lint like any other: file roles come from the path below the working directory`
    );
  }
} finally {
  rmSync(projectRootWorkspace, { recursive: true, force: true });
}

const deriveWorkspace = mkdtempSync(join(tmpdir(), "antidrift-derive-"));
try {
  const sampleRoot = resolve(repoRoot, "apps/shape-sample");
  const copyRoot = join(deriveWorkspace, "apps/shape-sample");
  cpSync(
    resolve(repoRoot, "tsconfig.base.json"),
    join(deriveWorkspace, "tsconfig.base.json")
  );
  symlinkSync(
    resolve(repoRoot, "node_modules"),
    join(deriveWorkspace, "node_modules"),
    "dir"
  );
  cpSync(sampleRoot, copyRoot, {
    recursive: true,
    filter: (source) =>
      !source.includes("node_modules") && !source.includes("/src/generated"),
  });
  const generatedFiles = [
    "wire.ts",
    "client.ts",
    "server.ts",
    "manifest.json",
    "derive-report.json",
  ];
  const cleanRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    cleanRun.status,
    0,
    `derive failed on the clean sample: ${cleanRun.stdout}${cleanRun.stderr}`
  );
  for (const name of generatedFiles) {
    assert.equal(
      readFileSync(join(copyRoot, "src/generated", name), "utf8"),
      readFileSync(join(sampleRoot, "src/generated", name), "utf8"),
      `apps/shape-sample/src/generated/${name} is stale; run antidrift-linter derive apps/shape-sample`
    );
  }
  const plantedViolations = {
    "src/methods/callbacky.ts":
      'import type { Session } from "../shared/session";\n\nexport async function callbacky(input: { label: string; onDone: () => void }, session: Session): Promise<string> {\n  input.onDone();\n  return Promise.resolve(session.userId);\n}\n',
    "src/methods/renamed.ts":
      'export async function somethingElse(): Promise<string> {\n  return Promise.resolve("renamed");\n}\n',
    "src/methods/syncMethod.ts":
      "export function syncMethod(label: string): string {\n  return label.toUpperCase();\n}\n",
    "src/methods/voidResult.ts":
      "export async function voidResult(): Promise<void> {\n  await Promise.resolve();\n}\n",
    "src/methods/optionalArg.ts":
      "export async function optionalArg(todoId: string, note?: string): Promise<string> {\n  return Promise.resolve(note ?? todoId);\n}\n",
    "src/routes/lists/route.ts":
      "export function GET(): Response {\n  return Response.json([]);\n}\n",
    "src/shared/asyncShared.ts":
      "export async function asyncShared(): Promise<number> {\n  return Promise.resolve(1);\n}\n",
    "src/methods/surrogateKey.ts":
      'export async function surrogateKey(input: { "x\\uD83D": string }): Promise<string> {\n  return Promise.resolve(input["x\\uD83D"]);\n}\n',
    "src/methods/surrogateLiteral.ts":
      'export async function surrogateLiteral(): Promise<"\\uD83D"> {\n  return "\\uD83D";\n}\n',
    "src/client/leaky.ts":
      'import { listTodos } from "../server/store";\n\nexport function leak(): Promise<number> {\n  return listTodos("any").then((todos) => todos.length);\n}\n',
  };
  for (const [file, source] of Object.entries(plantedViolations)) {
    mkdirSync(dirname(join(copyRoot, file)), { recursive: true });
    writeFileSync(join(copyRoot, file), source);
  }
  const plantedRun = spawnSync(binaryPath, ["derive", copyRoot], {
    encoding: "utf8",
  });
  assert.equal(
    plantedRun.status,
    1,
    `derive must exit 1 on violations: ${plantedRun.stdout}${plantedRun.stderr}`
  );
  const plantedReport = JSON.parse(
    readFileSync(join(copyRoot, "src/generated/derive-report.json"), "utf8")
  );
  assert.deepEqual(
    plantedReport.diagnostics
      .map((diagnostic) => `${diagnostic.file} ${diagnostic.rule}`)
      .sort(),
    [
      "client/leaky.ts client-reaches-server",
      "methods/callbacky.ts method-param-not-wire",
      "methods/optionalArg.ts method-param-not-wire",
      "methods/renamed.ts method-export-name",
      "methods/surrogateKey.ts method-param-not-wire",
      "methods/surrogateLiteral.ts method-result-not-wire",
      "methods/syncMethod.ts method-must-be-async",
      "methods/voidResult.ts method-result-not-wire",
      "routes/lists/route.ts route-must-be-async",
      "shared/asyncShared.ts shared-must-be-sync",
    ]
  );
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  for (const name of generatedFiles) {
    assert.doesNotThrow(
      () =>
        strictUtf8.decode(readFileSync(join(copyRoot, "src/generated", name))),
      `derive must write ${name} as valid UTF-8`
    );
  }
  for (const name of ["wire.ts", "client.ts", "server.ts"]) {
    assert.equal(
      readFileSync(join(copyRoot, "src/generated", name), "utf8"),
      readFileSync(join(sampleRoot, "src/generated", name), "utf8"),
      `planted violations must not change the derived ${name}`
    );
  }
} finally {
  rmSync(deriveWorkspace, { recursive: true, force: true });
}

const sampleSmoke = spawnSync(
  resolve(repoRoot, "node_modules/.bin/tsx"),
  ["apps/shape-sample/smoke/run.ts"],
  { cwd: repoRoot, encoding: "utf8" }
);
assert.equal(
  sampleSmoke.status,
  0,
  `shape-sample smoke failed: ${sampleSmoke.stdout}${sampleSmoke.stderr}`
);
assert.deepEqual(sampleSmoke.stdout.trim().split("\n"), [
  "ok   addTodo round-trips through derived decoders, Date included",
  "ok   malformed wire input fails at the boundary and names the field",
  "ok   completeTodo enforces ownership through the injected session",
  "ok   publication streams typed patches and stops when the client stops",
  "ok   publication withholds other owners' patches",
  "ok   client view model renders the optimistic patch, then the server's",
  "ok   route GET /todos/[id] serves JSON and refuses other owners",
  "7/7 steps passed",
]);

console.log(
  `✓ antidrift-linter Rust smoke passed (${registeredRules.size} rules registered, ${batchResults.length} portable batch cases + ${headlessProbes.length + 2} native tsrslint headless probes + failure-path, project-root, derive, line-cap & rust linter smokes verified)`
);

proveOxlintPluginBridge(repoRoot);
