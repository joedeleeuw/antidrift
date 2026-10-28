use super::RustDiagnostic;
use super::rules::check_syn_ast;
use super::syntax::check_file_surface;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use syn::{Attribute, Expr, ExprLit, Item, ItemMod, Lit, Meta};

pub(super) fn check_workspace_root(
    root: &Path,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    let crate_dirs = discover_crate_dirs(root)?;
    let mut total_files = 0usize;
    for crate_dir in crate_dirs {
        total_files += check_crate_dir(root, &crate_dir, diagnostics)?;
    }
    Ok(total_files)
}

fn discover_crate_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    if root.join("Cargo.toml").is_file() && root.join("src").is_dir() {
        return Ok(vec![root.to_path_buf()]);
    }
    let crates_parent = if root.join("crates").is_dir() {
        root.join("crates")
    } else {
        root.to_path_buf()
    };
    let mut dirs = Vec::new();
    if crates_parent.is_dir() {
        let entries = fs::read_dir(&crates_parent)
            .map_err(|err| format!("failed to read {}: {err}", crates_parent.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
            let path = entry.path();
            if path.is_dir() && path.join("Cargo.toml").is_file() {
                dirs.push(path);
            }
        }
        dirs.sort();
    }
    Ok(dirs)
}

fn check_crate_dir(
    workspace_root: &Path,
    crate_dir: &Path,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    let manifest_path = crate_dir.join("Cargo.toml");
    if manifest_path.is_file() {
        let manifest_rel = relative_display(workspace_root, &manifest_path);
        let manifest_text = fs::read_to_string(&manifest_path)
            .map_err(|err| format!("failed to read {}: {err}", manifest_path.display()))?;
        check_cargo_manifest(&manifest_rel, crate_dir, &manifest_text, diagnostics);
    }

    let src_dir = crate_dir.join("src");
    if !src_dir.is_dir() {
        return Ok(0);
    }
    let mut rs_files = Vec::new();
    collect_rs_files(&src_dir, &mut rs_files)?;
    rs_files.sort();

    let mut parsed_files: FxHashMap<PathBuf, syn::File> = FxHashMap::default();
    for file_path in &rs_files {
        let rel_path = relative_display(workspace_root, file_path);
        let source = fs::read_to_string(file_path)
            .map_err(|err| format!("failed to read {}: {err}", file_path.display()))?;
        check_file_surface(&rel_path, file_path, &source, diagnostics);
        match syn::parse_file(&source) {
            Ok(ast) => {
                check_syn_ast(&rel_path, file_path, &ast, diagnostics);
                parsed_files.insert(file_path.clone(), ast);
            }
            Err(err) => {
                diagnostics.push(RustDiagnostic {
                    file: rel_path,
                    line: err.span().start().line.max(1),
                    rule_id: "rust/syntax-error",
                    message: format!("Failed to parse Rust source: {err}"),
                });
            }
        }
    }

    check_orphan_modules(
        workspace_root,
        &src_dir,
        &rs_files,
        &parsed_files,
        diagnostics,
    );
    Ok(rs_files.len())
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    Ok(())
}

fn check_orphan_modules(
    workspace_root: &Path,
    src_dir: &Path,
    rs_files: &[PathBuf],
    parsed_files: &FxHashMap<PathBuf, syn::File>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let mut roots = Vec::new();
    for root_name in ["lib.rs", "main.rs"] {
        let candidate = src_dir.join(root_name);
        if parsed_files.contains_key(&candidate) {
            roots.push(candidate);
        }
    }
    if roots.is_empty() {
        return;
    }

    let mut reachable: FxHashSet<PathBuf> = FxHashSet::default();
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    for root in roots {
        if reachable.insert(root.clone()) {
            queue.push_back(root);
        }
    }

    while let Some(current) = queue.pop_front() {
        let Some(ast) = parsed_files.get(&current) else {
            continue;
        };
        let search_dir = module_search_dir(&current);
        let mut declared = Vec::new();
        collect_external_mods(&ast.items, &search_dir, &mut declared);
        for target in declared {
            if reachable.insert(target.clone()) {
                queue.push_back(target);
            }
        }
    }

    for file_path in rs_files {
        if !reachable.contains(file_path) {
            let rel_path = relative_display(workspace_root, file_path);
            diagnostics.push(RustDiagnostic {
                file: rel_path,
                line: 1,
                rule_id: "rust/no-orphan-module",
                message:
                    "Rust source file is not reachable from any Cargo target root (lib.rs or main.rs); wire `mod` or delete the orphan file."
                        .to_string(),
            });
        }
    }
}

fn module_search_dir(file_path: &Path) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if matches!(file_name, "lib.rs" | "main.rs" | "mod.rs") {
        parent.to_path_buf()
    } else {
        let stem = file_path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        parent.join(stem)
    }
}

fn collect_external_mods(items: &[Item], base_dir: &Path, out: &mut Vec<PathBuf>) {
    for item in items {
        let Item::Mod(item_mod) = item else {
            continue;
        };
        if let Some((_, inline_items)) = &item_mod.content {
            let inline_dir = base_dir.join(item_mod.ident.to_string());
            collect_external_mods(inline_items, &inline_dir, out);
            continue;
        }
        if let Some(resolved) = resolve_external_mod(item_mod, base_dir) {
            out.push(resolved);
        }
    }
}

fn resolve_external_mod(item_mod: &ItemMod, base_dir: &Path) -> Option<PathBuf> {
    if let Some(custom_path) = extract_path_attr(&item_mod.attrs) {
        let candidate = base_dir.join(custom_path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let name = item_mod.ident.to_string();
    let direct = base_dir.join(format!("{name}.rs"));
    if direct.is_file() {
        return Some(direct);
    }
    let nested = base_dir.join(name).join("mod.rs");
    if nested.is_file() {
        return Some(nested);
    }
    None
}

fn extract_path_attr(attrs: &[Attribute]) -> Option<String> {
    for attr in attrs {
        if !attr.path().is_ident("path") {
            continue;
        }
        let Meta::NameValue(nv) = &attr.meta else {
            continue;
        };
        let Expr::Lit(ExprLit {
            lit: Lit::Str(lit_str),
            ..
        }) = &nv.value
        else {
            continue;
        };
        return Some(lit_str.value());
    }
    None
}

fn check_cargo_manifest(
    manifest_rel: &str,
    crate_dir: &Path,
    manifest_text: &str,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let sections = parse_toml_sections(manifest_text);
    let has_workspace_lints = sections
        .iter()
        .any(|sec| sec.header == "[lints]" && sec.kv.get("workspace") == Some(&"true".to_string()));
    if !has_workspace_lints {
        diagnostics.push(RustDiagnostic {
            file: manifest_rel.to_string(),
            line: 1,
            rule_id: "rust/target-manifest-policy",
            message: "Crate Cargo.toml must inherit `[lints] workspace = true`.".to_string(),
        });
    }

    for sec in &sections {
        if matches!(sec.header.as_str(), "[lib]" | "[[bin]]") {
            if sec.kv.get("test") != Some(&"false".to_string()) {
                diagnostics.push(RustDiagnostic {
                    file: manifest_rel.to_string(),
                    line: sec.line,
                    rule_id: "rust/target-manifest-policy",
                    message: format!("Section {} must set `test = false`.", sec.header),
                });
            }
            if sec.kv.get("doctest") != Some(&"false".to_string()) {
                diagnostics.push(RustDiagnostic {
                    file: manifest_rel.to_string(),
                    line: sec.line,
                    rule_id: "rust/target-manifest-policy",
                    message: format!("Section {} must set `doctest = false`.", sec.header),
                });
            }
        }
    }

    let crate_name = crate_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    for sec in &sections {
        if sec.header == "[dependencies]" {
            check_dependency_dag(manifest_rel, crate_name, sec, diagnostics);
        }
    }
}

fn check_dependency_dag(
    manifest_rel: &str,
    crate_name: &str,
    sec: &TomlSection,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    if crate_name == "antidrift-kernel" {
        for forbidden in ["antidrift-rules", "antidrift-linter"] {
            if sec.kv.contains_key(forbidden) {
                diagnostics.push(RustDiagnostic {
                    file: manifest_rel.to_string(),
                    line: sec.line,
                    rule_id: "rust/target-manifest-policy",
                    message: format!("antidrift-kernel cannot depend on {forbidden}."),
                });
            }
        }
    } else if crate_name == "antidrift-rules" && sec.kv.contains_key("antidrift-linter") {
        diagnostics.push(RustDiagnostic {
            file: manifest_rel.to_string(),
            line: sec.line,
            rule_id: "rust/target-manifest-policy",
            message: "antidrift-rules cannot depend on antidrift-linter.".to_string(),
        });
    }
}

struct TomlSection {
    header: String,
    line: usize,
    kv: FxHashMap<String, String>,
}

fn parse_toml_sections(text: &str) -> Vec<TomlSection> {
    let mut sections = Vec::new();
    let mut current = TomlSection {
        header: String::new(),
        line: 1,
        kv: FxHashMap::default(),
    };

    for (idx, raw_line) in text.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if !current.header.is_empty() {
                sections.push(current);
            }
            current = TomlSection {
                header: trimmed.to_string(),
                line: line_no,
                kv: FxHashMap::default(),
            };
            continue;
        }
        if let Some((raw_key, raw_val)) = trimmed.split_once('=') {
            let key = raw_key
                .trim()
                .split('.')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let val = raw_val.trim().to_string();
            current.kv.insert(key, val);
        }
    }
    if !current.header.is_empty() {
        sections.push(current);
    }
    sections
}

fn relative_display(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}
