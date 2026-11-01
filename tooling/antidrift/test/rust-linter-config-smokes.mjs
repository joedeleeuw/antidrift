import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir, writeCrate } from "./rust-linter-process.mjs";
import {
  rustSmokeManifest,
  writeRustSmokeWorkspace,
} from "./rust-smoke-workspace.mjs";

const SILENT_BY_DEFAULT_RULE_IDS = [
  "rust/no-inline-comment",
  "rust/no-inline-tests",
  "rust/no-layer-violation",
  "rust/no-forbidden-call",
];

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

export function shippedDefaultsSmoke(linter) {
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

export function decodeFailureSmoke(linter) {
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
    '[workspace]\nmembers = ["crates/member", "crates/other", "../sibling"]\nexclude = ["crates/standalone", "nested"]\n\n[workspace.dependencies]\ninherited-dep = { path = "crates/inherited" }\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = { level = "error", exclude-files = ["crates/member/src/lib.rs"] }\n'
  );
  writeFileSync(
    join(root, "nested/Cargo.toml"),
    '[workspace]\nmembers = ["pkg"]\n\n[workspace.metadata.antidrift]\nrules."rust/no-boolean-map" = "off"\n'
  );
  writeCrate(
    join(root, "crates/member"),
    "member",
    "\n[dependencies]\ninherited-dep = { workspace = true }\n\n[target.'cfg(unix)'.dependencies]\ntarget-dep = { path = \"../target-dep\" }\n"
  );
  writeCrate(join(root, "crates/other"), "other");
  writeCrate(join(root, "crates/inherited"), "inherited-dep");
  writeCrate(join(root, "crates/target-dep"), "target-dep");
  writeCrate(
    join(root, "crates/standalone"),
    "standalone",
    '\n[package.metadata.antidrift]\nrules."rust/no-boolean-map" = "warn"\n'
  );
  writeCrate(join(root, "nested/pkg"), "nested-pkg");
}

function externalAndAutomaticMemberSmokes(linter, parent, root, booleanMaps) {
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
  writeCrate(join(parent, "sibling"), "sibling", 'workspace = "../ws"\n');
  assert.deepEqual(
    booleanMaps(".", join(parent, "sibling")),
    ["src/lib.rs:2 rust/no-boolean-map error"],
    "An external workspace member declared with package.workspace settles diagnostics relative to its scan root"
  );
  assert.deepEqual(
    booleanMaps(".", join(root, "crates/inherited")),
    ["src/lib.rs:2 rust/no-boolean-map error"],
    "A crate reached through [workspace.dependencies] inheritance (workspace = true) is a workspace member"
  );
  assert.deepEqual(
    booleanMaps(".", join(root, "crates/target-dep")),
    ["src/lib.rs:2 rust/no-boolean-map error"],
    "A crate reached only through a target-specific path dependency is a workspace member"
  );
}

export function configOwnerSmoke(linter) {
  withTempDir("antidrift-rust-owners-", (parent) => {
    const root = join(parent, "ws");
    mkdirSync(root, { recursive: true });
    writeOwnerWorkspace(root);
    const booleanMaps = (target, cwd) =>
      linter
        .findings(target, cwd)
        .filter((line) => line.includes("rust/no-boolean-map"));
    assert.deepEqual(
      booleanMaps(root),
      [
        "crates/inherited/src/lib.rs:2 rust/no-boolean-map error",
        "crates/other/src/lib.rs:2 rust/no-boolean-map error",
        "crates/standalone/src/lib.rs:2 rust/no-boolean-map warn",
        "crates/target-dep/src/lib.rs:2 rust/no-boolean-map error",
      ],
      "A workspace scan reads each crate's level from its owning manifest: the workspace table for members, the package table for an excluded package, the nested workspace's table for its members"
    );
    externalAndAutomaticMemberSmokes(linter, parent, root, booleanMaps);
  });
}

export function workspaceLintsSmoke(linter) {
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

export function rootPackageLintsSmoke(linter) {
  withTempDir("antidrift-rust-root-lints-", (root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/lib.rs"), "pub fn one() -> u8 {\n    1\n}\n");
    const manifest = (lints) =>
      `[workspace]\n\n[package]\nname = "root"\nversion = "0.0.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n\n[workspace.lints.rust]\nunsafe_code = "forbid"\n${lints}`;
    writeFileSync(join(root, "Cargo.toml"), manifest(""));
    assert.deepEqual(
      linter.findings(root),
      ["Cargo.toml:1 rust/require-workspace-lints error"],
      "A root package that is also the workspace must inherit its own [workspace.lints]"
    );
    writeFileSync(
      join(root, "Cargo.toml"),
      manifest("\n[lints]\nworkspace = true\n")
    );
    assert.deepEqual(
      linter.findings(root),
      [],
      "A root package that inherits [workspace.lints] reports nothing"
    );
  });
}
