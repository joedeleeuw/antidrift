use super::RustDiagnostic;
use super::boundary_decode::check_decode_to_option;
use super::cargo_manifest::{check_cargo_manifest, parse_toml_sections};
use super::constant_fields::check_constant_return_fields;
use super::module_graph::{declared_modules, normalize_lexical_path};
use super::rules::check_syn_ast;
use super::struct_index::StructIndex;
use super::struct_shapes::check_structural_type_forks;
use super::syntax::check_file_surface;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use syn::{Item, Type};

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
    if root_ref.is_file()
        && root_ref
            .extension()
            .is_some_and(|extension| extension == "rs")
    {
        if let Some(crate_dir) = root_ref
            .ancestors()
            .skip(1)
            .find(|directory| directory.join("Cargo.toml").is_file())
        {
            let workspace_dir = crate_dir
                .ancestors()
                .skip(1)
                .find(|directory| directory.join("Cargo.toml").is_file())
                .unwrap_or(crate_dir);
            let target_rel = relative_display(workspace_dir, root_ref);
            let mut crate_diags = Vec::new();
            check_crate_dir(workspace_dir, crate_dir, &mut crate_diags)?;
            diagnostics.extend(
                crate_diags
                    .into_iter()
                    .filter(|diag| diag.file == target_rel),
            );
            return Ok(1);
        }
        let display_root = root_ref.parent().unwrap_or(Path::new("."));
        check_source_file(display_root, root_ref, diagnostics)?;
        return Ok(1);
    }
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
    if dir.join("Cargo.toml").is_file() {
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
    let manifest_rel = relative_display(workspace_root, &manifest_path);
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|err| format!("failed to read {}: {err}", manifest_path.display()))?;
    let sections = parse_toml_sections(&manifest_text);
    if !sections.iter().any(|section| section.header == "[package]") {
        return Ok(0);
    }
    check_cargo_manifest(&manifest_rel, crate_dir, &sections, diagnostics);
    let src_dir = normalize_lexical_path(&crate_dir.join("src"));
    let mut rs_files = Vec::new();
    if src_dir.is_dir() {
        collect_rs_files(&src_dir, &mut rs_files)?;
    }
    let mut target_roots = Vec::new();
    for section in &sections {
        if matches!(section.header.as_str(), "[lib]" | "[[bin]]")
            && let Some(target_path) = section.kv.get("path")
        {
            let relative = target_path.trim_matches(['\'', '"']);
            let target = normalize_lexical_path(&crate_dir.join(relative));
            if !target.is_file() {
                return Err(format!(
                    "{}: target path '{}' is not a file; point [lib].path or [[bin]].path at an existing Rust source file",
                    manifest_path.display(),
                    relative
                ));
            }
            rs_files.push(target.clone());
            target_roots.push(target);
        }
    }
    rs_files.sort();
    rs_files.dedup();

    let mut parsed_files = FxHashMap::default();
    let mut pending: VecDeque<_> = rs_files.into_iter().collect();
    let mut visited = FxHashSet::default();
    while let Some(file) = pending.pop_front() {
        if !visited.insert(file.clone()) {
            continue;
        }
        if let Some(ast) = check_source_file(workspace_root, &file, diagnostics)? {
            pending.extend(declared_modules(&file, target_roots.contains(&file), &ast));
            parsed_files.insert(file, ast);
        }
    }
    let mut rs_files: Vec<_> = visited.into_iter().collect();
    rs_files.sort();

    check_orphan_modules(
        workspace_root,
        &src_dir,
        &rs_files,
        &parsed_files,
        target_roots,
        diagnostics,
    );
    let index = StructIndex::new(&rs_files, &parsed_files);
    check_structural_type_forks(workspace_root, &index, diagnostics);
    check_constant_return_fields(
        workspace_root,
        &index,
        &rs_files,
        &parsed_files,
        diagnostics,
    );
    Ok(rs_files.len())
}

fn check_source_file(
    workspace_root: &Path,
    file_path: &Path,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<Option<syn::File>, String> {
    let rel_path = relative_display(workspace_root, file_path);
    let source = fs::read_to_string(file_path)
        .map_err(|err| format!("failed to read {}: {err}", file_path.display()))?;
    check_file_surface(&rel_path, file_path, &source, diagnostics);
    match syn::parse_file(&source) {
        Ok(ast) => {
            check_syn_ast(&rel_path, file_path, &ast, diagnostics);
            check_decode_to_option(&rel_path, &ast, diagnostics);
            check_rule_scope_ownership(&rel_path, &ast, diagnostics);
            return Ok(Some(ast));
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
    Ok(None)
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read directory entry: {err}"))?;
        let path = entry.path();
        if path.is_dir()
            && !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with('.')
                        || ["target", "node_modules", "vendor", "dist"].contains(&name)
                })
        {
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
    mut roots: Vec<PathBuf>,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
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
    let target_roots: FxHashSet<_> = roots.iter().cloned().collect();
    for root in roots {
        if reachable.insert(root.clone()) {
            queue.push_back(root);
        }
    }

    while let Some(current) = queue.pop_front() {
        let Some(ast) = parsed_files.get(&current) else {
            continue;
        };
        let declared = declared_modules(&current, target_roots.contains(&current), ast);
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
                    "Rust source file is not reachable from any Cargo target root (including manifest target paths); wire `mod` or delete the orphan file.".to_owned(),
            });
        }
    }
}

pub(super) fn relative_display(root: &Path, path: &Path) -> String {
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
