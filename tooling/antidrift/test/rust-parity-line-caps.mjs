import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { loadPolicy } from "../src/policy/generate-policy-artifacts.mjs";

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

const lineCapDetector = /^antidrift:([^,]+),warnAt:(\d+),max:(\d+)$/u;

const lineCapShapes = {
  "rust/max-module-lines": {
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

const rustRuleRowsSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.enum(["general", "house-style"]),
    level: z.enum(["error", "warn", "off"]),
    lineCap: z.object({ warnAbove: z.number(), max: z.number() }).optional(),
  })
);

const lineCapBoundaries = ({ warnAt, max }) => [
  [warnAt, []],
  [warnAt + 1, ["warn"]],
  [max, ["warn"]],
  [max + 1, ["error"]],
];

function parsePolicyLineCap({ detector }) {
  const match = lineCapDetector.exec(detector ?? "");
  if (!match) return [];
  const [, rule, warnAt, max] = match;
  return [
    { ruleId: `antidrift/${rule}`, warnAt: Number(warnAt), max: Number(max) },
  ];
}

function loadRustRuleRows(binaryPath, repoRoot) {
  const rows = rustRuleRowsSchema.parse(
    JSON.parse(
      execFileSync(
        binaryPath,
        ["rust", "--list-rules", "--format", "json", repoRoot],
        { cwd: repoRoot, encoding: "utf8" }
      )
    )
  );
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "house-style")
      .map((row) => `${row.id}=${row.level}`),
    ["rust/no-inline-comment=error", "rust/no-inline-tests=error"],
    "antidrift's own Cargo.toml must turn the house-style rules on"
  );
  return rows;
}

async function loadLineCaps(binaryPath, repoRoot) {
  const rustRuleRows = loadRustRuleRows(binaryPath, repoRoot);
  const policy = policyRowsSchema.parse(
    await loadPolicy(resolve(repoRoot, "policy/agent-guardrails.yaml"))
  );
  const lineCaps = [
    ...policy.clusters
      .flatMap(({ rules }) => rules)
      .flatMap(parsePolicyLineCap),
    ...rustRuleRows.flatMap((row) =>
      row.lineCap
        ? [
            {
              ruleId: row.id,
              warnAt: row.lineCap.warnAbove,
              max: row.lineCap.max,
            },
          ]
        : []
    ),
  ];
  assert.deepEqual(
    lineCaps.map(({ ruleId }) => ruleId).sort(),
    Object.keys(lineCapShapes).sort(),
    "policy/agent-guardrails.yaml must declare warnAt and max for every line-cap unit"
  );
  return lineCaps;
}

function buildScriptCases(lineCaps, workspace) {
  return lineCaps
    .filter(({ ruleId }) => ruleId.startsWith("antidrift/"))
    .flatMap((cap) =>
      lineCapBoundaries(cap).map(([count, expected]) => ({
        id: `${cap.ruleId}:${count}`,
        filename: join(
          workspace,
          `${cap.ruleId.replace("antidrift/", "")}-${count}.tsx`
        ),
        cwd: workspace,
        sourceText: lineCapSource(cap.ruleId, count),
        rules: { [cap.ruleId]: "error" },
        cap,
        expected,
      }))
    );
}

const CLASSIFICATION_CASES = [
  [
    "default-export-fn-component",
    "default-export.tsx",
    "export default function () {",
    "  return <div />;",
    "}",
    [],
  ],
  [
    "default-export-memo-component",
    "default-memo.tsx",
    "export default memo(forwardRef((props: { items: string[] }, ref) => {",
    "  return <ul>{props.items.map((item) => <li key={item}>{item}</li>)}</ul>;",
    "}));",
    [],
  ],
  [
    "nested-helper-before-jsx-component",
    "nested-helper.tsx",
    "export function View() {\n  function small() { return 1; }",
    "  return <div>{small()}</div>;",
    "}",
    [],
  ],
  [
    "default-param-jsx-not-component",
    "default-param-jsx.tsx",
    "export function BuildReport(template = <div />) {",
    "  return String(template);",
    "}",
    ["antidrift/max-function-lines:error"],
  ],
  [
    "callback-param-jsx-not-component",
    "callback-param-jsx.tsx",
    "declare const values: unknown[];\nexport function BuildReport() {",
    "  return values.map((template: unknown = <div />) => String(template));",
    "}",
    ["antidrift/max-function-lines:error"],
  ],
];

function buildClassificationCases(workspace) {
  const pad = Array.from(
    { length: 55 },
    (_, index) => `  const v${index} = ${index};`
  );
  const rules = {
    "antidrift/max-function-lines": "error",
    "antidrift/max-component-lines": "error",
  };
  return CLASSIFICATION_CASES.map(([id, file, head, ret, tail, expected]) => ({
    id,
    filename: join(workspace, file),
    cwd: workspace,
    sourceText: [head, ...pad, ret, tail].join("\n"),
    rules,
    expected,
  }));
}

function verifyScriptLineCaps({ binaryPath, repoRoot, workspace, lineCaps }) {
  const scriptCases = buildScriptCases(lineCaps, workspace);
  const classificationCases = buildClassificationCases(workspace);
  const batchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
    cwd: repoRoot,
    input: JSON.stringify([
      ...scriptCases.map(
        ({ cap: _cap, expected: _expected, ...request }) => request
      ),
      ...classificationCases.map(
        ({ expected: _expected, ...request }) => request
      ),
    ]),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const scriptResults = new Map(
    lineCapBatchSchema
      .parse(JSON.parse(batchOutput))
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
  for (const { id, expected } of classificationCases) {
    assert.deepEqual(
      (scriptResults.get(id) ?? []).map(
        ({ ruleId, severity }) => `${ruleId}:${severity}`
      ),
      expected,
      `${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(scriptResults.get(id))}`
    );
  }
}

function verifyRustLineCaps({ binaryPath, repoRoot, workspace, rustCap }) {
  assert.ok(
    rustCap,
    "antidrift-linter rust --list-rules must declare rust/max-module-lines"
  );
  for (const [count, expected] of lineCapBoundaries(rustCap)) {
    const rustFile = join(workspace, `cap_${count}.rs`);
    writeFileSync(rustFile, lineCapSource(rustCap.ruleId, count));
    const rustRun = spawnSync(binaryPath, ["rust", "--json", rustFile], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.deepEqual(
      JSON.parse(rustRun.stdout)
        .filter(({ ruleId }) => ruleId === rustCap.ruleId)
        .map(({ severity }) => severity),
      expected,
      `rust/max-module-lines at ${count} non-blank lines`
    );
    assert.equal(rustRun.status, expected.includes("error") ? 1 : 0);
  }
  const nearFile = join(workspace, `cap_${rustCap.warnAt + 1}.rs`);
  const denied = spawnSync(
    binaryPath,
    ["rust", "--json", "--deny-warnings", nearFile],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );
  assert.equal(
    denied.status,
    1,
    `Expected near-cap Rust file to fail under --deny-warnings`
  );
}

function headlessFunctionCapPayload(repoRoot, lineCaps) {
  const functionCap = lineCaps.find(
    ({ ruleId }) => ruleId === "antidrift/max-function-lines"
  );
  assert.ok(functionCap, "policy must declare antidrift/max-function-lines");
  const nearFile = resolve(
    repoRoot,
    "tooling/antidrift/src/__probe_line_cap.ts"
  );
  return {
    ruleId: functionCap.ruleId,
    payload: {
      version: 2,
      configs: [
        { file_paths: [nearFile], rules: [{ name: functionCap.ruleId }] },
      ],
      source_overrides: {
        [nearFile]: lineCapSource(functionCap.ruleId, functionCap.warnAt + 1),
      },
    },
  };
}

export async function proveLineCapSmokes({
  binaryPath,
  repoRoot,
  runHeadlessProbe,
}) {
  const lineCaps = await loadLineCaps(binaryPath, repoRoot);
  const workspace = mkdtempSync(join(tmpdir(), "antidrift-line-caps-"));
  try {
    verifyScriptLineCaps({ binaryPath, repoRoot, workspace, lineCaps });
    verifyRustLineCaps({
      binaryPath,
      repoRoot,
      workspace,
      rustCap: lineCaps.find(
        ({ ruleId }) => ruleId === "rust/max-module-lines"
      ),
    });
    const { ruleId, payload } = headlessFunctionCapPayload(repoRoot, lineCaps);
    const diags = runHeadlessProbe(payload);
    assert.deepEqual(
      diags.map(({ rule }) => rule),
      [ruleId]
    );
    assert.match(diags[0].message.description, /warn threshold/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
