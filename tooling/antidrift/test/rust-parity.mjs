import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorkspaceLinter } from "../src/policy/generate-policy-artifacts.mjs";
import { buildBoundaryProbes } from "./boundary-probes.mjs";
import {
  buildSharedHelperFiles,
  coreHeadlessProbes,
  portableCases,
} from "./portable-cases.mjs";
import {
  headlessRuleProbes,
  proveInferredTypesSmoke,
  verifyHeaderAndOptionFailureProbes,
} from "./headless-rule-probes.mjs";
import { proveOxlintPluginBridge } from "./oxlint-plugin-bridge.mjs";
import {
  proveDeriveSmoke,
  proveProjectRootSmoke,
} from "./rust-parity-derive.mjs";
import { proveLineCapSmokes } from "./rust-parity-line-caps.mjs";
import { runRustLinterSmokes } from "./rust-linter-smokes.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const binaryPath = buildWorkspaceLinter(repoRoot);

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
  'export const hostPath = "/home/joe/\\uD83D";',
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
  'export const downloadResponse = new Response("body", { headers: { "Content-Disposition": "attachment; filename=x\\uD83D" } });',
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
assert.equal(
  loneSurrogateDiags.filter(
    (diag) => diag.rule === "antidrift/no-host-path-literal"
  ).length,
  1,
  `Expected lone-surrogate host path literal to report, got ${JSON.stringify(loneSurrogateDiags)}`
);
assert.deepEqual(
  loneSurrogateDiags
    .filter((diag) => diag.rule === "antidrift/no-raw-foreground-opacity")
    .map((diag) => diag.range.pos),
  [
    loneSurrogateSource.indexOf('"text-foreground/50 \\uD83D"'),
    loneSurrogateSource.indexOf('"text-foreground/50">ok'),
  ],
  `Lone-surrogate literals must lint without aborting and report both raw foreground opacity classNames, got ${JSON.stringify(loneSurrogateDiags)}`
);
assert.equal(
  loneSurrogateDiags.filter(
    (diag) => diag.rule === "antidrift/no-sql-string-concat"
  ).length,
  2,
  `A lone surrogate in a SQL fragment must not hide the dynamic input, got ${JSON.stringify(loneSurrogateDiags)}`
);
assert.equal(
  loneSurrogateDiags.filter(
    (diag) => diag.rule === "antidrift/require-secure-document-response"
  ).length,
  1,
  `A lone surrogate in a Content-Disposition header must not hide an attachment download response, got ${JSON.stringify(loneSurrogateDiags)}`
);

const sqlDefaultDiags = runHeadlessProbe({
  version: 2,
  configs: [
    {
      file_paths: [probeFileA],
      rules: [
        { name: "no-floating-promises" },
        { name: "antidrift/no-sql-string-concat" },
      ],
    },
  ],
  source_overrides: {
    [probeFileA]: `
        export function queryUser(userId: string) {
          return \`SELECT id FROM users WHERE id = \${userId}\`;
        }
      `,
  },
});
assert.equal(
  sqlDefaultDiags.filter(
    (diag) => diag.rule === "antidrift/no-sql-string-concat"
  ).length,
  1,
  `Expected a requested antidrift rule to report antidrift/no-sql-string-concat as a rule diagnostic, got ${JSON.stringify(sqlDefaultDiags)}`
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

runRustLinterSmokes({ binaryPath, repoRoot });
await proveLineCapSmokes({ binaryPath, repoRoot, runHeadlessProbe });
proveProjectRootSmoke(binaryPath);
verifyHeaderAndOptionFailureProbes(runHeadlessProbe, probeFileA);
proveInferredTypesSmoke(binaryPath, repoRoot);
proveDeriveSmoke(binaryPath, repoRoot);

console.log(
  `✓ antidrift-linter Rust smoke passed (${registeredRules.size} rules registered, ${batchResults.length} portable batch cases + ${headlessProbes.length + 2} native tsrslint headless probes + failure-path, project-root, inferred-types, derive, line-cap, rust config-owner, decode & workspace-lints smokes verified)`
);

await proveOxlintPluginBridge(repoRoot, binaryPath);
