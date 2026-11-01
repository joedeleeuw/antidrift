import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRustSmokeWorkspace } from "./rust-smoke-workspace.mjs";

const BOOLEAN_MAP_SOURCE =
  "use std::collections::HashMap;\npub struct Flags { pub seen: HashMap<String, bool> }\n";

export function withTempDir(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeCrate(dir, name, metadata = "") {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.0.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n${metadata}`
  );
  writeFileSync(join(dir, "src/lib.rs"), BOOLEAN_MAP_SOURCE);
}

export function rustLinter({ binaryPath, repoRoot }) {
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
