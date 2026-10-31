import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  rustHouseStyleMetadata,
  rustSmokeManifest,
  writeRustSmokeWorkspace,
} from "./rust-smoke-workspace.mjs";

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

const SILENT_BY_DEFAULT_RULE_IDS = [
  "rust/no-inline-comment",
  "rust/no-inline-tests",
  "rust/no-layer-violation",
  "rust/no-forbidden-call",
];

const BOOLEAN_MAP_SOURCE =
  "use std::collections::HashMap;\npub struct Flags { pub seen: HashMap<String, bool> }\n";

const HOP_CRATE = {
  "Cargo.toml":
    '[package]\nname = "hops"\nversion = "0.0.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n',
  "src/lib.rs":
    "pub mod db;\npub mod glob;\npub mod samename;\npub mod user;\n",
  "src/db.rs": "mod inner;\npub use self::inner::find_x;\n",
  "src/db/inner.rs":
    "pub fn find_x(n: usize) -> usize {\n    find_x_impl(n)\n}\nfn find_x_impl(n: usize) -> usize {\n    n + 1\n}\n",
  "src/glob.rs": "mod inner;\npub use self::inner::*;\n",
  "src/glob/inner.rs":
    "pub fn find_y(n: usize) -> usize {\n    find_y_impl(n)\n}\nfn find_y_impl(n: usize) -> usize {\n    n + 2\n}\n",
  "src/samename.rs":
    "pub mod implementation {\n    pub fn wrap(n: usize) -> usize {\n        n * 2\n    }\n}\npub fn wrap(n: usize) -> usize {\n    implementation::wrap(n)\n}\n",
  "src/user.rs":
    "use crate::db::find_x;\nuse crate::glob::find_y;\npub fn go() -> usize {\n    find_x(1) + find_y(2) + crate::glob::find_y(3)\n}\n",
};

function withTempDir(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCrate(dir, name, metadata = "") {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.0.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n${metadata}`
  );
  writeFileSync(join(dir, "src/lib.rs"), BOOLEAN_MAP_SOURCE);
}

function rustLinter({ binaryPath, repoRoot }) {
  const run = (args, cwd = repoRoot) =>
    spawnSync(binaryPath, args, { cwd, encoding: "utf8" });
  const diagnostics = (target, cwd = repoRoot) => {
    const spawned = run(["rust", "--json", target], cwd);
    const printed = String(spawned.stdout ?? "").trim();
    return { run: spawned, diags: printed === "" ? [] : JSON.parse(printed) };
  };
  return {
    run,
    diagnostics,
    findings(target, cwd = repoRoot) {
      const { run: spawned, diags } = diagnostics(target, cwd);
      assert.ok(
        spawned.status === 0 || spawned.status === 1,
        `Expected antidrift-linter rust to lint ${target}, got ${spawned.status}: ${spawned.stderr}`
      );
      return diags
        .map(
          (diag) => `${diag.file}:${diag.line} ${diag.ruleId} ${diag.severity}`
        )
        .sort();
    },
    decodeFailure(manifest) {
      return withTempDir("antidrift-rust-decode-", (dir) => {
        writeRustSmokeWorkspace(dir, "");
        writeFileSync(join(dir, "Cargo.toml"), manifest);
        const spawned = run(["rust", "--json", dir]);
        assert.notEqual(
          spawned.status,
          0,
          `Expected the manifest to be rejected: ${manifest}`
        );
        return spawned.stderr;
      });
    },
  };
}

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

function manifestOverridesSmoke(linter, workspace, defaultDiags) {
  const setMetadata = (table) =>
    writeFileSync(
      join(workspace, "Cargo.toml"),
      rustSmokeManifest(`[workspace.metadata.antidrift]\n${table}\n`)
    );
  const booleanMapFiles = (reports) =>
    reports
      .filter((diag) => diag.ruleId === "rust/no-boolean-map")
      .map((diag) => `${diag.file}:${diag.line}`);
  setMetadata(
    'rules."rust/no-boolean-map" = { level = "error", exclude-files = ["crates/antidrift-kernel/src/provenance.rs"] }'
  );
  const scoped = linter.diagnostics(workspace);
  assert.deepEqual(
    [booleanMapFiles(defaultDiags), booleanMapFiles(scoped.diags)],
    [["crates/antidrift-kernel/src/provenance.rs:8"], []],
    `Expected exclude-files to scope rust/no-boolean-map out of provenance.rs, got ${JSON.stringify(scoped.diags)}`
  );
  rejectedMetadataSmoke(linter, workspace, setMetadata);
}

function rejectedMetadataSmoke(linter, workspace, setMetadata) {
  setMetadata('rules."rust/no-such-rule" = "error"');
  const unknownRule = linter.run(["rust", "--json", workspace]);
  assert.notEqual(
    unknownRule.status,
    0,
    "Expected an unknown rule id to fail the run"
  );
  assert.ok(
    unknownRule.stderr.includes(
      "[workspace.metadata.antidrift] rules names unknown rule 'rust/no-such-rule'"
    ) && unknownRule.stderr.includes(join(workspace, "Cargo.toml")),
    `Expected the unknown rule error to name the manifest and the rule, got ${unknownRule.stderr}`
  );
  setMetadata(
    'rules."rust/no-boolean-map" = { level = "error", colour = "blue" }'
  );
  const unknownKey = linter.run(["rust", "--json", workspace]);
  assert.notEqual(
    unknownKey.status,
    0,
    "Expected an unknown metadata key to fail the run"
  );
  assert.ok(
    unknownKey.stderr.includes("invalid Cargo manifest") &&
      unknownKey.stderr.includes("colour"),
    `Expected the unknown key error to name the key, got ${unknownKey.stderr}`
  );
}

function shippedDefaultsSmoke(linter) {
  withTempDir("antidrift-rust-defaults-", (workspace) => {
    writeRustSmokeWorkspace(workspace, "");
    const listed = linter.run(["rust", "--list-rules", workspace]);
    assert.equal(
      listed.status,
      0,
      `Expected --list-rules to exit 0, got ${listed.status}: ${listed.stderr}`
    );
    assert.ok(
      listed.stdout.includes("rust/no-inline-comment off") &&
        listed.stdout.includes("rust/no-inline-tests off") &&
        listed.stdout.includes("rust/no-structural-type-fork error"),
      `Expected --list-rules to show shipped defaults, got ${listed.stdout}`
    );
    const { run, diags } = linter.diagnostics(workspace);
    assert.equal(
      run.status,
      1,
      `Expected default run to exit 1, got ${run.status}: ${run.stderr}`
    );
    const reported = new Set(diags.map((diag) => diag.ruleId));
    for (const silentRuleId of SILENT_BY_DEFAULT_RULE_IDS) {
      assert.ok(
        !reported.has(silentRuleId),
        `Expected ${silentRuleId} to stay silent by default (house-style rules ship off; layer and forbidden-call rules need configuration), got ${JSON.stringify(diags)}`
      );
    }
    assert.deepEqual(
      diags
        .filter((diag) => diag.ruleId === "rust/no-structural-type-fork")
        .map((diag) => [diag.file, diag.line, diag.severity]),
      [["crates/antidrift-kernel/src/provenance.rs", 6, "error"]],
      `Expected general rules to stay on by default, got ${JSON.stringify(diags)}`
    );
    manifestOverridesSmoke(linter, workspace, diags);
  });
}

function decodeFailureSmoke(linter) {
  const invalidLevel = linter.decodeFailure(
    rustSmokeManifest(
      '[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = "loud"\n'
    )
  );
  assert.ok(
    invalidLevel.includes("rust/no-boolean-map") &&
      invalidLevel.includes("unknown level 'loud'") &&
      invalidLevel.includes("valid levels: off, warn, error"),
    `Expected an invalid level to name the rule, the level and the valid levels, got ${invalidLevel}`
  );
  const multilineUnknownField = linter.decodeFailure(
    rustSmokeManifest(
      '[workspace.metadata.antidrift.rules."rust/no-boolean-map"]\nlevel = "error"\ncolour = "blue"\n'
    )
  );
  assert.ok(
    multilineUnknownField.includes("colour") &&
      multilineUnknownField.includes("invalid Cargo manifest"),
    `Expected a multiline rule table with an unknown field to name the field, got ${multilineUnknownField}`
  );
}

function writeOwnerWorkspace(root) {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(
    join(root, "Cargo.toml"),
    '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/standalone", "nested"]\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = { level = "error", exclude-files = ["crates/member/src/lib.rs"] }\n'
  );
  writeFileSync(
    join(root, "nested/Cargo.toml"),
    '[workspace]\nmembers = ["pkg"]\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = "off"\n'
  );
  writeCrate(join(root, "crates/member"), "member");
  writeCrate(join(root, "crates/other"), "other");
  writeCrate(
    join(root, "crates/standalone"),
    "standalone",
    '\n[package.metadata.antidrift]\nrules."rust/no-boolean-map" = "warn"\n'
  );
  writeCrate(join(root, "nested/pkg"), "nested-pkg");
}

function configOwnerSmoke(linter) {
  withTempDir("antidrift-rust-owners-", (root) => {
    writeOwnerWorkspace(root);
    const booleanMaps = (target, cwd) =>
      linter
        .findings(target, cwd)
        .filter((line) => line.includes("rust/no-boolean-map"));
    assert.deepEqual(
      booleanMaps(root),
      [
        "crates/other/src/lib.rs:2 rust/no-boolean-map error",
        "crates/standalone/src/lib.rs:2 rust/no-boolean-map warn",
      ],
      "A workspace scan reads each crate's level from its owning manifest: the workspace table for members, the package table for an excluded package, the nested workspace's table for its members"
    );
    assert.deepEqual(
      booleanMaps(".", join(root, "crates/member")),
      [],
      "A member scanned directly keeps its workspace's table, and the workspace's exclude-files glob matches relative to the workspace manifest"
    );
    assert.deepEqual(
      booleanMaps(".", join(root, "crates/other")),
      ["src/lib.rs:2 rust/no-boolean-map error"],
      "A member scanned directly reports under the workspace's level"
    );
    assert.deepEqual(
      booleanMaps(".", join(root, "crates/standalone")),
      ["src/lib.rs:2 rust/no-boolean-map warn"],
      "An excluded package scanned directly reads its own package table"
    );
    assert.deepEqual(
      booleanMaps(".", join(root, "nested/pkg")),
      [],
      "A nested workspace's member reads the nested workspace's table"
    );
  });
}

function workspaceLintsSmoke(linter) {
  withTempDir("antidrift-rust-lints-", (root) => {
    const workspaceLints = () =>
      linter
        .findings(root)
        .filter((line) => line.includes("rust/require-workspace-lints"));
    writeFileSync(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\n\n[workspace.lints.rust]\nunsafe_code = "deny"\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = "off"\n'
    );
    writeCrate(
      join(root, "crates/inherits"),
      "inherits",
      "\n[lints]\nworkspace = true\n"
    );
    writeCrate(join(root, "crates/detached"), "detached");
    assert.deepEqual(
      workspaceLints(),
      ["crates/detached/Cargo.toml:1 rust/require-workspace-lints error"],
      "A workspace that declares [workspace.lints] requires every member to inherit it"
    );
    writeFileSync(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = "off"\n'
    );
    assert.deepEqual(
      workspaceLints(),
      [],
      "Without [workspace.lints] no member has anything to inherit"
    );
  });
}

function wrapperResolutionSmoke(linter) {
  withTempDir("antidrift-rust-hops-", (root) => {
    for (const [relative, text] of Object.entries(HOP_CRATE)) {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), text);
    }
    const hops = linter
      .diagnostics(root)
      .diags.filter((diag) => diag.ruleId === "rust/no-wrapping-functions")
      .map(
        (diag) =>
          `${diag.file} ${diag.message.split(":")[0]} ${diag.message.match(/at its (\d+) call site/u)?.[1]}`
      )
      .sort();
    assert.deepEqual(
      hops,
      [
        "src/db/inner.rs 'find_x' is a hop to 'find_x_impl' 1",
        "src/glob/inner.rs 'find_y' is a hop to 'find_y_impl' 2",
      ],
      "Wrapper call sites resolve through explicit and glob re-exports (find_x once, find_y twice), and a same-name hop whose only in-crate call is its own body is not a hop"
    );
  });
}

export function runRustLinterSmokes({ binaryPath, repoRoot }) {
  const linter = rustLinter({ binaryPath, repoRoot });
  houseStyleSmoke(linter);
  singleFileSmoke(linter);
  shippedDefaultsSmoke(linter);
  decodeFailureSmoke(linter);
  configOwnerSmoke(linter);
  workspaceLintsSmoke(linter);
  wrapperResolutionSmoke(linter);
}
