import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withTempDir, writeCrate } from "./rust-linter-process.mjs";

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

const ENUM_TWIN_STRUCTS =
  "pub struct BlockStatement { pub start: u32, pub end: u32, pub depth: u8 }\npub struct StaticBlock { pub start: u32, pub end: u32, pub depth: u8 }\npub struct Span { pub start: u32, pub end: u32, pub depth: u8 }\n";

export function enumTwinSmoke(linter) {
  withTempDir("antidrift-rust-enum-twins-", (root) => {
    writeCrate(root, "twins");
    const structs = ENUM_TWIN_STRUCTS;
    const forks = () =>
      linter
        .findings(root)
        .filter((line) => line.includes("rust/no-structural-type-fork"));
    writeFileSync(
      join(root, "src/lib.rs"),
      `${structs}pub enum Statement { Block(Box<BlockStatement>), Static(Box<StaticBlock>) }\n`
    );
    assert.deepEqual(
      forks(),
      ["src/lib.rs:3 rust/no-structural-type-fork error"],
      "Structs that are payloads of variants of one enum are nominal twins by design; a same-shaped struct outside the enum still reports"
    );
    writeFileSync(
      join(root, "src/lib.rs"),
      `${structs}pub enum Pair { Both(Box<BlockStatement>, Box<StaticBlock>) }\n`
    );
    assert.deepEqual(
      forks(),
      [
        "src/lib.rs:2 rust/no-structural-type-fork error",
        "src/lib.rs:3 rust/no-structural-type-fork error",
      ],
      "Two same-shaped structs carried by one variant are not twins; the exemption needs two variants of one enum"
    );
    writeFileSync(join(root, "src/lib.rs"), structs);
    assert.deepEqual(
      forks(),
      [
        "src/lib.rs:2 rust/no-structural-type-fork error",
        "src/lib.rs:3 rust/no-structural-type-fork error",
      ],
      "Without the enum both same-shaped structs report"
    );
  });
}

export function shadowedFallbackSmoke(linter) {
  withTempDir("antidrift-rust-shadow-", (root) => {
    writeCrate(root, "shadow");
    writeFileSync(
      join(root, "src/lib.rs"),
      "pub fn parse_or_empty(input: &str) -> String {\n    match input.parse::<u32>() {\n        Ok(n) => n.to_string(),\n        Err(_) => {\n            let fallback = String::new();\n            let fallback = fallback;\n            fallback\n        }\n    }\n}\n"
    );
    assert.deepEqual(
      linter.findings(root),
      ["src/lib.rs:4 rust/no-silent-result-discard error"],
      "A fallback rebound to itself resolves to its earlier initializer instead of looping"
    );
  });
}

export function wrapperResolutionSmoke(linter) {
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

const CFG_SUPPRESSION_SOURCE = [
  "pub struct Helper;",
  "impl Helper { pub fn unused(&self) -> usize { 1 } }",
  "pub fn method_name_not_justification(unused: usize, helper: &Helper) -> usize {",
  "    let _ = unused;",
  "    #[cfg(unix)]",
  "    let count = helper.unused();",
  "    #[cfg(not(unix))]",
  "    let count = 0;",
  "    count",
  "}",
  "pub fn shadowed_binding_not_justification(unused: usize) -> usize {",
  "    let _ = unused;",
  "    #[cfg(unix)]",
  "    let count = { let unused = 2; unused };",
  "    #[cfg(not(unix))]",
  "    let count = 0;",
  "    count",
  "}",
  "pub fn real_cfg_use_justified(used_on_unix: usize) -> usize {",
  "    let _ = used_on_unix;",
  "    #[cfg(unix)]",
  "    let count = used_on_unix + 1;",
  "    #[cfg(not(unix))]",
  "    let count = 0;",
  "    count",
  "}",
  "",
].join("\n");

export function cfgSuppressionAndMacroModuleSmoke(linter) {
  withTempDir("antidrift-rust-cfg-macro-", (root) => {
    writeCrate(root, "cfg-macro");
    writeFileSync(join(root, "src/lib.rs"), CFG_SUPPRESSION_SOURCE);
    assert.deepEqual(
      linter
        .findings(root)
        .filter((line) => line.includes("rust/no-let-underscore-suppression")),
      [
        "src/lib.rs:12 rust/no-let-underscore-suppression error",
        "src/lib.rs:4 rust/no-let-underscore-suppression error",
      ],
      "Only expression uses of the suppressed binding justify let _ = ...; method calls and shadowed bindings still report"
    );
    writeFileSync(
      join(root, "Cargo.toml"),
      '[package]\nname = "cfg-macro"\nversion = "0.0.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n\n[package.metadata.antidrift]\nmodule-macros = ["declare_custom_mod"]\n'
    );
    writeFileSync(
      join(root, "src/lib.rs"),
      'macro_rules! noop { ($id:ident) => {}; }\nmacro_rules! declare_custom_mod { ($id:ident) => {}; }\nnoop!(orphan);\ndeclare_custom_mod!(custom_owned);\ninclude!("included.rs");\n'
    );
    writeFileSync(join(root, "src/orphan.rs"), "pub fn orphan() {}\n");
    writeFileSync(
      join(root, "src/custom_owned.rs"),
      "pub fn custom_owned() {}\n"
    );
    writeFileSync(join(root, "src/included.rs"), "pub fn included() {}\n");
    assert.deepEqual(
      linter
        .findings(root)
        .filter((line) => line.includes("rust/no-orphan-module")),
      ["src/orphan.rs:1 rust/no-orphan-module error"],
      "Arbitrary macro invocations do not grant module ownership, while include! and configured module-macros do"
    );
  });
}
