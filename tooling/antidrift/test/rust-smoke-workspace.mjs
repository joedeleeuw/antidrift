import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const rustSmokeManifest = (metadata) =>
  `[workspace]\nmembers = ["crates/antidrift-kernel", "crates/antidrift-rules"]\n${metadata}`;
export const rustHouseStyleMetadata = [
  "[workspace.metadata.antidrift]",
  'rules."rust/no-inline-comment" = "error"',
  'rules."rust/no-inline-tests" = "error"',
  'rules."rust/no-stringly-variant" = "warn"',
  'layers.crates = ["antidrift-kernel", "antidrift-rules", "antidrift-engine"]',
  'layers.modules.antidrift-kernel = ["provenance", "shape", "projection", "boundary", "callgraph"]',
  "",
  "[[workspace.metadata.antidrift.forbidden-calls]]",
  'callee = "Listener::Enter"',
  'argument = "Kind::SourceFile"',
  'reason = "Listener::Enter(Kind::SourceFile) never fires in tsrslint."',
  "",
].join("\n");
const provenanceSource = [
  "use crate::{ boundary::BoundaryItem, boundary::load_raw_manifest };",
  "use antidrift_engine::Session;",
  "use serde::Deserialize;",
  "use std::collections::HashMap;",
  "// forbidden inline comment",
  "pub struct FrameBounds { pub x: i32, pub y: i32, pub width: u32 }",
  "#[derive(Deserialize)]",
  "pub struct LooseConfig { pub kind: String, pub seen: HashMap<String, bool>, pub item: Option<BoundaryItem> }",
  "pub fn decode_rule_options(name: &str) -> Result<usize, String> { Ok(name.len()) }",
  "pub fn adapter(input: &str) -> Result<usize, String> { decode_rule_options(input) }",
  "pub fn legacy_adapter(input: &str) -> Result<usize, String> {",
  "    decode_rule_options(input)?;",
  "    input.parse::<usize>().map_err(|err| err.to_string())",
  "}",
  "pub(crate) fn hop_wrapper(input: &str) -> Result<usize, String> { let _ = input; legacy_adapter(input) }",
  "pub struct Holder { pub ident: String }",
  "pub struct ProjectMeta { pub project_id: String, pub project_key: String }",
  "pub struct RawEvent<'a> { pub r#type: std::borrow::Cow<'a, str>, pub state: String }",
  "pub fn parse_pair() -> (Option<String>, Option<u32>) { (None, None) }",
  "#[derive(Default, Deserialize)]",
  "#[serde(deny_unknown_fields)]",
  'pub struct DefaultedConfig { #[serde(default = "default_port")] pub port: u16 }',
  "fn default_port() -> u16 { 8080 }",
  "pub fn decode_and_validate(raw: &str) -> Result<(), String> {",
  '    let cfg: DefaultedConfig = serde_json::from_str(raw).map_err(|e| format!("bad config: {e}"))?;',
  "    validate_config(&cfg)",
  "}",
  "fn validate_config(_c: &DefaultedConfig) -> Result<(), String> { Ok(()) }",
  "pub fn pre_validate_only(raw: &str) -> Result<DefaultedConfig, String> {",
  "    validate_raw(raw);",
  '    serde_json::from_str(raw).map_err(|e| format!("bad config: {e}"))',
  "}",
  "fn validate_raw(_raw: &str) {}",
  "pub struct StatusEnvelope { pub(crate) ok: bool, pub count: usize }",
  "pub struct OutcomeBag { pub ok: bool, pub count: usize, pub error: Option<String> }",
  "pub fn make_envelope_a(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n } }",
  "pub fn make_envelope_b(n: usize) -> StatusEnvelope { StatusEnvelope { ok: true, count: n + 1 } }",
  "pub fn empty_on_error(h: &Holder) -> Vec<u8> { match legacy_adapter(&h.ident) { Ok(_) => vec![1], Err(_) => Vec::new() } }",
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
  'pub fn hop_user() -> Result<usize, String> { hop_wrapper("x") }',
  "pub fn bad_dynamic_leak(s: String) -> &'static str { Box::leak(s.into_boxed_str()) }",
  "pub trait DeadMarker { fn id(&self) -> u8; }",
  "impl DeadMarker for Holder { fn id(&self) -> u8 { 1 } }",
  "impl DeadMarker for ProjectMeta { fn id(&self) -> u8 { 2 } }",
  "#[cfg(all(test))]\nmod inline_tests {}",
  "",
];

function writeKernelCrate(tempWorkspace) {
  const kernelSrc = join(tempWorkspace, "crates/antidrift-kernel/src");
  mkdirSync(kernelSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-kernel/Cargo.toml"),
    '[package]\nname = "antidrift-kernel"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\n\n[dependencies]\nantidrift-engine = { path = "../antidrift-engine" }\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(kernelSrc, "lib.rs"),
    "pub mod boundary;\npub mod provenance;\n#[cfg(test)]\nmod roundtrip_tests;\n"
  );
  writeFileSync(
    join(kernelSrc, "boundary.rs"),
    "pub struct BoundaryItem;\npub struct WindowBounds { pub x: i32, pub y: i32, pub width: u32 }\npub fn load_raw_manifest() -> serde_json::Value { serde_json::Value::Null }\n"
  );
  writeFileSync(
    join(kernelSrc, "roundtrip_tests.rs"),
    "use crate::provenance::Holder;\npub fn roundtrip(h: &Holder) -> Holder {\n    let raw = serde_json::to_string(h).unwrap();\n    serde_json::from_str(&raw).unwrap()\n}\n"
  );
  writeFileSync(
    join(kernelSrc, "generated_shapes.rs"),
    "// @generated by the smoke; DO NOT EDIT\npub struct GeneratedBounds { pub x: i32, pub y: i32, pub width: u32 }\n"
  );
  writeFileSync(join(kernelSrc, "provenance.rs"), provenanceSource.join("\n"));
  writeFileSync(join(kernelSrc, "orphan_file.rs"), "pub fn unused() {}\n");
}

function writeRulesCrate(tempWorkspace) {
  const rulesSrc = join(tempWorkspace, "crates/antidrift-rules/src");
  mkdirSync(rulesSrc, { recursive: true });
  writeFileSync(
    join(tempWorkspace, "crates/antidrift-rules/Cargo.toml"),
    '[package]\nname = "antidrift-rules"\nversion = "0.20.0"\n\n[lib]\npath = "src/lib.rs"\ntest = false\ndoctest = false\n\n[lints]\nworkspace = true\n'
  );
  writeFileSync(
    join(rulesSrc, "lib.rs"),
    "pub enum Kind { SourceFile }\npub enum Listener { Enter(Kind) }\npub fn listener() -> Listener { Listener::Enter(Kind::SourceFile) }\n"
  );
}

export function writeRustSmokeWorkspace(tempWorkspace, metadata) {
  writeFileSync(join(tempWorkspace, "Cargo.toml"), rustSmokeManifest(metadata));
  writeKernelCrate(tempWorkspace);
  writeRulesCrate(tempWorkspace);
}
