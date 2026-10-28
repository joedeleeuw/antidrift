import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { portableCases } from "./portable-cases.mjs";

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

const batchRuleIds = new Set([
  "antidrift/no-as-never",
  "antidrift/no-debug-residue-filenames",
]);
const batchInputs = [];
const expectations = new Map();

for (const entry of portableCases) {
  const fullRuleId = `antidrift/${entry.name}`;
  if (!batchRuleIds.has(fullRuleId)) {
    continue;
  }
  const invalidId = `${entry.name}:invalid`;
  const validId = `${entry.name}:valid`;
  const invalidFilename = entry.filename ?? "component.tsx";
  const validFilename =
    entry.validFilename ?? entry.filename ?? "component.tsx";

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

const rawBatchOutput = execFileSync(binaryPath, ["--batch-json", "-"], {
  cwd: repoRoot,
  input: JSON.stringify(batchInputs),
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const batchResults = JSON.parse(rawBatchOutput);
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

function parseHeadlessOutput(buf) {
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
      diagnostics.push(JSON.parse(payloadText));
    } else if (kind === 0) {
      throw new Error(`Headless protocol error: ${payloadText}`);
    }
  }
  return diagnostics;
}

function runHeadlessProbe(payload, extraEnv = {}) {
  const proc = spawnSync(binaryPath, ["headless"], {
    cwd: repoRoot,
    input: Buffer.from(JSON.stringify(payload), "utf8"),
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = parseHeadlessOutput(proc.stdout ?? Buffer.alloc(0));
  if (proc.status !== 0) {
    throw new Error(
      `Headless process exited with ${proc.status}: ${(proc.stderr ?? Buffer.alloc(0)).toString("utf8")}`
    );
  }
  return parsed;
}

const probeFileA = resolve(repoRoot, "tooling/antidrift/src/__probe_a.ts");
const probeFileB = resolve(repoRoot, "tooling/antidrift/src/__probe_b.ts");

const headlessProbes = [
  {
    name: "unknown-input-must-be-decoded (call argument & assignment sinks)",
    rule: "antidrift/unknown-input-must-be-decoded",
    source: `
      type Account = { id: string };
      declare function consume(account: Account): void;
      export async function load(response: Response) {
        consume(await response.json());
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-unsafe-deserialize (alias-to-contract)",
    rule: "antidrift/no-unsafe-deserialize",
    source: `
      type Account = { id: string };
      export function parseAccount(text: string) {
        const raw = JSON.parse(text);
        const account: Account = raw;
        return account.id;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-identity-schema-transform (direct identity x => x)",
    rule: "antidrift/no-identity-schema-transform",
    source: `
      import { z } from "zod";
      export const schema = z.string().transform((value) => value);
    `,
    expectedCount: 1,
  },
  {
    name: "no-redundant-zod-parse (z.infer<typeof schema>)",
    rule: "antidrift/no-redundant-zod-parse",
    source: `
      import { z } from "zod";
      const schema = z.object({ id: z.string() });
      export function handle(input: z.infer<typeof schema>) {
        return schema.parse(input);
      }
    `,
    expectedCount: 1,
  },
  {
    name: "no-wrapping-functions (widened return type string | null must stay clean)",
    rule: "antidrift/no-wrapping-functions",
    source: `
      function readId(item: { id: string }): string {
        return item.id;
      }
      export function readNullableId(item: { id: string }): string | null {
        return readId(item);
      }
    `,
    expectedCount: 0,
  },
  {
    name: "no-appeasement-cast (unresolved import target)",
    rule: "antidrift/no-appeasement-cast",
    source: `
      import type { Account } from "./nonexistent-module-for-probe.js";
      export function castIt(input: unknown) {
        return input as Account;
      }
    `,
    expectedCount: 1,
  },
  {
    name: "inline eslint-disable-next-line suppresses native antidrift rule",
    rule: "antidrift/no-compat-names",
    source: `
      // eslint-disable-next-line antidrift/no-compat-names -- probe
      export const legacyAdapter = 1;
    `,
    expectedCount: 0,
  },
  {
    name: "eslint-disable inside string literal does not suppress native antidrift rule",
    rule: "antidrift/no-compat-names",
    source: `
      export const fakeDirective = "/* eslint-disable antidrift/no-compat-names */";
      export const legacyAdapter = 1;
    `,
    expectedCount: 1,
  },
  {
    name: "no-vague-names (duplicate context stem)",
    rule: "antidrift/no-vague-names",
    source: "export function loadUserUser() {}\n",
    expectedCount: 1,
  },
];

for (const probe of headlessProbes) {
  const diags = runHeadlessProbe({
    version: 2,
    configs: [
      {
        file_paths: [probeFileA],
        rules: [{ name: probe.rule }],
      },
    ],
    source_overrides: {
      [probeFileA]: probe.source,
    },
  });
  assert.equal(
    diags.length,
    probe.expectedCount,
    `Headless probe '${probe.name}' expected ${probe.expectedCount} diagnostics, got ${JSON.stringify(diags)}`
  );
}

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
assert.ok(
  sqlDefaultDiags.some(
    (diag) => diag.message?.id === "antidrift/no-sql-string-concat"
  ),
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
    [
      "[package]",
      'name = "antidrift-kernel"',
      'version = "0.20.0"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "test = false",
      "",
      "[lints]",
      "workspace = true",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(kernelSrc, "lib.rs"),
    "pub mod boundary;\npub mod provenance;\n"
  );
  writeFileSync(join(kernelSrc, "boundary.rs"), "pub struct BoundaryItem;\n");
  writeFileSync(
    join(kernelSrc, "provenance.rs"),
    [
      "use crate::{",
      "    boundary::BoundaryItem,",
      "};",
      "use serde::Deserialize;",
      "use std::collections::HashMap;",
      "// forbidden inline comment",
      "#[derive(Deserialize)]",
      "pub struct LooseConfig {",
      "    pub kind: String,",
      "    pub seen: HashMap<String, bool>,",
      "    pub item: Option<BoundaryItem>,",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(join(kernelSrc, "orphan_file.rs"), "pub fn unused() {}\n");
  writeFileSync(join(kernelSrc, "bad_helpers.rs"), "pub fn helper() {}\n");

  const rustSubcmd = spawnSync(binaryPath, ["rust", "--json", tempWorkspace], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    rustSubcmd.status,
    1,
    `Expected antidrift-linter rust to exit 1 on violations, got ${rustSubcmd.status}: ${rustSubcmd.stderr}`
  );
  const rustDiags = JSON.parse(rustSubcmd.stdout);
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
  ]) {
    assert.ok(
      reportedRuleIds.has(expectedRuleId),
      `Expected antidrift-linter rust to report ${expectedRuleId}, got ${JSON.stringify(rustDiags)}`
    );
  }
} finally {
  rmSync(tempWorkspace, { recursive: true, force: true });
}

console.log(
  `✓ antidrift-linter Rust smoke passed (${registeredRules.size} rules registered, ${batchResults.length} portable batch cases + ${headlessProbes.length + 2} native tsrslint headless probes + failure-path & rust linter smokes verified)`
);
