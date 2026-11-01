import assert from "node:assert/strict";
import {
  rustHouseStyleMetadata,
  writeRustSmokeWorkspace,
} from "./rust-smoke-workspace.mjs";
import { withTempDir, rustLinter } from "./rust-linter-process.mjs";
import {
  shippedDefaultsSmoke,
  decodeFailureSmoke,
  configOwnerSmoke,
  workspaceLintsSmoke,
  rootPackageLintsSmoke,
} from "./rust-linter-config-smokes.mjs";
import {
  enumTwinSmoke,
  shadowedFallbackSmoke,
  wrapperResolutionSmoke,
} from "./rust-linter-resolution-smokes.mjs";

const HOUSE_STYLE_RULE_IDS = [
  "rust/no-inline-comment",
  "rust/no-layer-violation",
  "rust/no-forbidden-call",
  "rust/require-strict-serde",
  "rust/no-stringly-variant",
  "rust/no-boolean-map",
  "rust/no-orphan-module",
  "rust/no-grab-bag-module",
  "rust/no-anemic-errors",
  "rust/no-compat-names",
  "rust/no-wrapping-functions",
  "rust/no-let-underscore-suppression",
  "rust/no-ident-to-string-compare",
  "rust/no-untyped-config-probe",
  "rust/no-inline-tests",
  "rust/no-silent-result-discard",
  "rust/no-structural-type-fork",
  "rust/no-value-roundtrip",
  "rust/no-decode-to-option",
  "rust/no-constant-return-field",
  "rust/no-redundant-owner-prefix",
  "rust/no-hollow-module",
  "rust/no-blocking-in-async",
  "rust/no-query-join-or-tree-reshape",
  "rust/no-contract-appeasement-projection",
];

const HOUSE_STYLE_MESSAGES = [
  'collapsed into "" via fallback',
  "Do not serialize and deserialize the same value",
  "wall-clock sleep 'std::thread::sleep' inside an async context",
  "Three or more independent reads are awaited one after another",
  "Nested '.find(...)' performs an O(N*M)",
  "spans multiple build output tiers",
  "Untyped config probe '.as_u64()'",
  "turns a failure into an empty value",
  "Section [lib] must set `doctest = false`",
  "Crate 'antidrift-kernel' (layer 0) cannot depend on 'antidrift-engine' (layer 2)",
  "Crate layer 0 cannot use 'antidrift-engine' (layer 2)",
  "Module layer 'provenance' (rank 0) cannot import higher layer 'boundary' (rank 3)",
  "'Listener::Enter' is forbidden here: Listener::Enter(Kind::SourceFile) never fires in tsrslint.",
  "'hop_wrapper' is a hop to 'legacy_adapter': inlining it at its 1 call site(s)",
];

const REMOVED_RULE_IDS = [
  "rust/target-manifest-policy",
  "rust/require-rule-scope",
  "rust/no-duplicate-scope-fields",
  "rust/no-discarded-decoded-config",
  "antidrift/no-tsrslint-sourcefile-listener",
];

function houseStyleShapeAsserts(diags) {
  const printed = JSON.stringify(diags);
  const byRule = (ruleId) => diags.filter((diag) => diag.ruleId === ruleId);
  assert.equal(
    diags.filter((diag) =>
      String(diag.message).startsWith("Success and failure arms")
    ).length,
    2,
    `Expected the match and if/else outcome bags to each report once, got ${printed}`
  );
  assert.equal(
    byRule("rust/no-decode-to-option").length,
    1,
    `Expected one decode-to-option report for the .ok() discard and none for the sniffed text input, got ${printed}`
  );
  assert.deepEqual(
    [...new Set(byRule("rust/no-value-roundtrip").map((diag) => diag.file))],
    ["crates/antidrift-kernel/src/provenance.rs"],
    `Expected the #[cfg(test)] module's serde round-trip to be skipped, got ${printed}`
  );
  assert.equal(
    diags.filter((diag) => diag.file.endsWith("generated_shapes.rs")).length,
    0,
    `Expected the @generated file to report nothing, got ${printed}`
  );
  assert.deepEqual(
    [
      ...new Set(
        byRule("rust/no-stringly-variant").map((diag) => diag.severity)
      ),
    ],
    ["warn"],
    `Expected the configured warn level to cap rust/no-stringly-variant, got ${printed}`
  );
}

function houseStyleSmoke(linter) {
  withTempDir("antidrift-rust-smoke-", (workspace) => {
    writeRustSmokeWorkspace(workspace, rustHouseStyleMetadata);
    const { run, diags } = linter.diagnostics(workspace);
    assert.equal(
      run.status,
      1,
      `Expected antidrift-linter rust to exit 1 on violations, got ${run.status}: ${run.stderr}`
    );
    const printed = JSON.stringify(diags);
    const reportedRuleIds = new Set(diags.map((diag) => diag.ruleId));
    for (const expectedRuleId of HOUSE_STYLE_RULE_IDS) {
      assert.ok(
        reportedRuleIds.has(expectedRuleId),
        `Expected antidrift-linter rust to report ${expectedRuleId}, got ${printed}`
      );
    }
    for (const expectedMessage of HOUSE_STYLE_MESSAGES) {
      assert.equal(
        diags.filter((diag) => String(diag.message).includes(expectedMessage))
          .length,
        1,
        `Expected antidrift-linter rust diagnostics to include '${expectedMessage}' once, got ${printed}`
      );
    }
    for (const absentRuleId of REMOVED_RULE_IDS) {
      assert.ok(
        !reportedRuleIds.has(absentRuleId),
        `Expected removed rule ${absentRuleId} to be gone, got ${printed}`
      );
    }
    houseStyleShapeAsserts(diags);
  });
}

function singleFileSmoke(linter) {
  const singleFile = linter.run([
    "rust",
    "crates/antidrift-linter/src/main.rs",
  ]);
  assert.equal(
    singleFile.status,
    0,
    `Expected single-file rust target to exit 0, got ${singleFile.status}: ${singleFile.stderr}`
  );
}

export function runRustLinterSmokes({ binaryPath, repoRoot }) {
  const linter = rustLinter({ binaryPath, repoRoot });
  houseStyleSmoke(linter);
  singleFileSmoke(linter);
  shippedDefaultsSmoke(linter);
  decodeFailureSmoke(linter);
  configOwnerSmoke(linter);
  workspaceLintsSmoke(linter);
  rootPackageLintsSmoke(linter);
  shadowedFallbackSmoke(linter);
  enumTwinSmoke(linter);
  wrapperResolutionSmoke(linter);
}
