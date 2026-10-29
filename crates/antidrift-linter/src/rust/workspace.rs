use super::RustDiagnostic;
use super::boundary_decode::check_decode_to_option;
use super::rules::check_syn_ast;
use super::struct_shapes::{check_constant_return_fields, check_structural_type_forks};
use super::syntax::check_file_surface;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use syn::{Attribute, Expr, ExprLit, Item, ItemMod, Lit, Meta, Type};

pub(super) fn check_workspace_root(
    root: &Path,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    let clean_root = normalize_lexical_path(root);
    let root_ref = if clean_root.as_os_str().is_empty() {
        Path::new(".")
    } else {
        clean_root.as_path()
    };
    let crate_dirs = discover_crate_dirs(root_ref)?;
    let mut total_files = 0usize;
    for crate_dir in crate_dirs {
        total_files += check_crate_dir(root_ref, &crate_dir, diagnostics)?;
    }
    Ok(total_files)
}

fn discover_crate_dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut dirs = Vec::new();
    collect_crate_dirs_recursive(root, &mut dirs)?;
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}

fn collect_crate_dirs_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if dir.join("Cargo.toml").is_file() && dir.join("src").is_dir() {
        out.push(dir.to_path_buf());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|err| format!("failed to read directory entry: {err}"))?
            .path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if matches!(
            name,
            ".git"
                | "target"
                | "node_modules"
                | "src"
                | "tests"
                | "benches"
                | "examples"
                | "vendor"
                | "dist"
        ) || name.starts_with('.')
        {
            continue;
        }
        collect_crate_dirs_recursive(&path, out)?;
    }
    Ok(())
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

    let src_dir = normalize_lexical_path(&crate_dir.join("src"));
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
                check_decode_to_option(&rel_path, &ast, diagnostics);
                check_rule_scope_ownership(&rel_path, &ast, diagnostics);
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
    check_structural_type_forks(workspace_root, &rs_files, &parsed_files, diagnostics);
    check_constant_return_fields(workspace_root, &rs_files, &parsed_files, diagnostics);
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
            out.push(normalize_lexical_path(&path));
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
    for file_path in rs_files {
        if let Ok(rel) = file_path.strip_prefix(src_dir)
            && rel.starts_with("bin")
        {
            roots.push(file_path.clone());
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
        let file_dir = current
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        let search_dir = module_search_dir(&current);
        let mut declared = Vec::new();
        collect_external_mods(&ast.items, &file_dir, &search_dir, &mut declared);
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
                    "Rust source file is not reachable from any Cargo target root (lib.rs or main.rs); wire `mod` or delete the orphan file.".to_owned(),
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

fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn collect_external_mods(items: &[Item], file_dir: &Path, base_dir: &Path, out: &mut Vec<PathBuf>) {
    for item in items {
        let Item::Mod(item_mod) = item else {
            continue;
        };
        if let Some((_, inline_items)) = &item_mod.content {
            let inline_dir = if let Some(custom) = extract_path_attr(&item_mod.attrs) {
                normalize_lexical_path(&file_dir.join(custom))
            } else {
                base_dir.join(item_mod.ident.to_string())
            };
            collect_external_mods(inline_items, file_dir, &inline_dir, out);
            continue;
        }
        if let Some(resolved) = resolve_external_mod(item_mod, file_dir, base_dir) {
            out.push(resolved);
        }
    }
}

fn resolve_external_mod(item_mod: &ItemMod, file_dir: &Path, base_dir: &Path) -> Option<PathBuf> {
    if let Some(custom_path) = extract_path_attr(&item_mod.attrs) {
        for base in [file_dir, base_dir] {
            let candidate = normalize_lexical_path(&base.join(&custom_path));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let name = item_mod.ident.to_string();
    [
        base_dir.join(format!("{name}.rs")),
        base_dir.join(&name).join("mod.rs"),
        file_dir.join(format!("{name}.rs")),
        file_dir.join(name).join("mod.rs"),
    ]
    .into_iter()
    .map(|p| normalize_lexical_path(&p))
    .find(|p| p.is_file())
}

fn extract_path_attr(attrs: &[Attribute]) -> Option<String> {
    attrs.iter().find_map(|attr| {
        if !attr.path().is_ident("path") {
            return None;
        }
        let Meta::NameValue(nv) = &attr.meta else {
            return None;
        };
        let Expr::Lit(ExprLit {
            lit: Lit::Str(s), ..
        }) = &nv.value
        else {
            return None;
        };
        Some(s.value())
    })
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
        .any(|sec| sec.header == "[lints]" && sec.kv.get("workspace") == Some(&"true".to_owned()));
    if !has_workspace_lints {
        diagnostics.push(RustDiagnostic {
            file: manifest_rel.to_owned(),
            line: 1,
            rule_id: "rust/target-manifest-policy",
            message: "Crate Cargo.toml must inherit `[lints] workspace = true`.".to_owned(),
        });
    }

    for sec in &sections {
        if matches!(sec.header.as_str(), "[lib]" | "[[bin]]") {
            if sec.kv.get("test") != Some(&"false".to_owned()) {
                diagnostics.push(RustDiagnostic {
                    file: manifest_rel.to_owned(),
                    line: sec.line,
                    rule_id: "rust/target-manifest-policy",
                    message: format!("Section {} must set `test = false`.", sec.header),
                });
            }
            if sec.kv.get("doctest") != Some(&"false".to_owned()) {
                diagnostics.push(RustDiagnostic {
                    file: manifest_rel.to_owned(),
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
                    file: manifest_rel.to_owned(),
                    line: sec.line,
                    rule_id: "rust/target-manifest-policy",
                    message: format!("antidrift-kernel cannot depend on {forbidden}."),
                });
            }
        }
    } else if crate_name == "antidrift-rules" && sec.kv.contains_key("antidrift-linter") {
        diagnostics.push(RustDiagnostic {
            file: manifest_rel.to_owned(),
            line: sec.line,
            rule_id: "rust/target-manifest-policy",
            message: "antidrift-rules cannot depend on antidrift-linter.".to_owned(),
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
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if !current.header.is_empty() {
                sections.push(current);
            }
            current = TomlSection {
                header: trimmed.to_owned(),
                line: idx + 1,
                kv: FxHashMap::default(),
            };
        } else if let Some((raw_key, raw_val)) = trimmed.split_once('=') {
            let key = raw_key.trim().split('.').next().unwrap_or("").trim();
            current.kv.insert(key.to_owned(), raw_val.trim().to_owned());
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

fn check_rule_scope_ownership(
    rel_path: &str,
    ast: &syn::File,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    if !rel_path.starts_with("crates/antidrift-rules/src/") {
        return;
    }
    let mut structs_with_scope: FxHashSet<String> = FxHashSet::default();
    let mut all_structs: FxHashSet<String> = FxHashSet::default();
    for item in &ast.items {
        let Item::Struct(item_struct) = item else {
            continue;
        };
        let name = item_struct.ident.to_string();
        all_structs.insert(name.clone());
        if item_struct
            .fields
            .iter()
            .any(|field| is_rule_scope_type(&field.ty))
        {
            structs_with_scope.insert(name);
        }
    }
    for item in &ast.items {
        let Item::Impl(item_impl) = item else {
            continue;
        };
        let Some((_, trait_path, _)) = &item_impl.trait_ else {
            continue;
        };
        if !trait_path
            .segments
            .last()
            .is_some_and(|seg| seg.ident == "Rule")
        {
            continue;
        }
        let Type::Path(self_path) = &*item_impl.self_ty else {
            continue;
        };
        let Some(last_seg) = self_path.path.segments.last() else {
            continue;
        };
        let struct_name = last_seg.ident.to_string();
        if all_structs.contains(&struct_name) && !structs_with_scope.contains(&struct_name) {
            diagnostics.push(RustDiagnostic {
                file: rel_path.to_owned(),
                line: last_seg.ident.span().start().line.max(1),
                rule_id: "rust/require-rule-scope",
                message: format!(
                    "Rule struct '{struct_name}' implements 'Rule' without a 'RuleScope' field; embed 'scope: RuleScope', expose 'from_options', and check 'in_scope' during visitor creation."
                ),
            });
        }
    }
}

fn is_rule_scope_type(ty: &Type) -> bool {
    let Type::Path(type_path) = ty else {
        return false;
    };
    type_path
        .path
        .segments
        .last()
        .is_some_and(|seg| seg.ident == "RuleScope")
}
