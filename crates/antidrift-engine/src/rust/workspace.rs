use super::RustDiagnostic;
use super::async_effects::check_async_effects;
use super::binding_hygiene::check_binding_hygiene;
use super::boundary_decode::{check_decode_to_option, check_strict_serde};
use super::cargo_manifest::{ManifestSource, check_cargo_manifest, read_manifest_source};
use super::catalog::row;
use super::config::RustConfig;
use super::config_owner::{ConfigResolver, absolute_path, discover_crate_dirs};
use super::constant_fields::check_constant_return_fields;
use super::contract_projection::check_contract_projections;
use super::error_handling::check_error_handling;
use super::lifecycle_names::CrateNames;
use super::module_boundaries::{CrateLayer, check_module_boundaries};
use super::module_graph::{
    ModuleCode, check_orphan_modules, declared_modules, normalize_lexical_path,
};
use super::result_discard::check_result_discards;
use super::source_context::SourceContext;
use super::struct_index::StructIndex;
use super::structural_type_fork::check_structural_type_forks;
use super::syntax::check_file_surface;
use super::type_representations::check_type_representations;
use super::value_flow::check_value_flow;
use super::wrapping::check_wrapping_functions;
use antidrift_kernel::diagnostic::Severity;
use antidrift_kernel::scope_policy::ScopePolicy;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

struct FilePassCtx<'a> {
    rel_path: &'a str,
    path: &'a Path,
    ast: &'a syn::File,
    crate_names: &'a CrateNames,
    index: Option<&'a StructIndex<'a>>,
}

type FilePassFn = fn(&FilePassCtx<'_>, &mut Vec<RustDiagnostic>);

const FILE_PASSES: &[FilePassFn] = &[
    |ctx, diags| check_strict_serde(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_decode_to_option(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_binding_hygiene(ctx.rel_path, ctx.path, ctx.ast, ctx.crate_names, diags),
    |ctx, diags| check_error_handling(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_result_discards(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_contract_projections(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_type_representations(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_async_effects(ctx.rel_path, ctx.ast, diags),
    |ctx, diags| check_value_flow(ctx.rel_path, ctx.path, ctx.index, ctx.ast, diags),
];

struct CratePassCtx<'a> {
    walk: &'a CrateWalk<'a>,
    index: &'a StructIndex<'a>,
    files: &'a [PathBuf],
    asts: &'a FxHashMap<PathBuf, syn::File>,
}

type CratePassFn = fn(&CratePassCtx<'_>, &mut Vec<RustDiagnostic>);

const CRATE_PASSES: &[CratePassFn] = &[
    |c, d| check_orphan_modules(c.walk, c.files, c.asts, d),
    |c, d| check_structural_type_forks(c.walk.workspace_root, c.index, d),
    |c, d| check_constant_return_fields(c.walk.workspace_root, c.index, c.files, c.asts, d),
    |c, d| check_wrapping_functions(c.walk.workspace_root, c.files, c.asts, d),
];

pub(super) fn check_workspace_root(
    root: &Path,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    let root_abs = absolute_path(root)?;
    let root_ref = root_abs.as_path();
    let mut resolver = ConfigResolver::default();
    if root_ref.is_file() && root_ref.extension().is_some_and(|ext| ext == "rs") {
        return check_single_file(root_ref, &mut resolver, diagnostics);
    }
    let mut total_files = 0usize;
    for crate_dir in discover_crate_dirs(root_ref)? {
        let config = resolver.config_for_package(&crate_dir)?;
        total_files += check_crate_dir(root_ref, &crate_dir, &config, diagnostics)?;
    }
    Ok(total_files)
}

fn check_single_file(
    file: &Path,
    resolver: &mut ConfigResolver,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    if let Some(crate_dir) = file
        .ancestors()
        .skip(1)
        .find(|dir| dir.join("Cargo.toml").is_file())
    {
        let config = resolver.config_for_package(crate_dir)?;
        let workspace_dir = if file.starts_with(&config.root_dir) {
            config.root_dir.as_path()
        } else {
            crate_dir
        };
        let target_rel = relative_display(workspace_dir, file);
        let mut crate_diags = Vec::new();
        check_crate_dir(workspace_dir, crate_dir, &config, &mut crate_diags)?;
        diagnostics.extend(crate_diags.into_iter().filter(|d| d.file == target_rel));
        return Ok(1);
    }
    let display_root = file.parent().unwrap_or(Path::new("."));
    let config = resolver.config_for_directory(display_root)?;
    let layer = CrateLayer {
        crate_name: None,
        top_module: None,
    };
    let mut file_diags = Vec::new();
    let mut contexts = FxHashMap::default();
    if let Some(ast) = check_source_file(
        display_root,
        file,
        &config,
        &layer,
        &mut contexts,
        &mut file_diags,
    )? {
        let rel_path = relative_display(display_root, file);
        let lone = FxHashMap::from_iter([(file.to_path_buf(), ast)]);
        let crate_names = CrateNames::collect(std::slice::from_ref(&file.to_path_buf()), &lone);
        let pass_ctx = FilePassCtx {
            rel_path: &rel_path,
            path: file,
            ast: &lone[&file.to_path_buf()],
            crate_names: &crate_names,
            index: None,
        };
        for pass in FILE_PASSES {
            pass(&pass_ctx, &mut file_diags);
        }
    }
    diagnostics.extend(settle_diagnostics(
        file_diags,
        &config,
        &contexts,
        display_root,
    )?);
    Ok(1)
}

fn check_crate_dir(
    workspace_root: &Path,
    crate_dir: &Path,
    config: &RustConfig,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<usize, String> {
    let manifest_path = crate_dir.join("Cargo.toml");
    let manifest_rel = relative_display(workspace_root, &manifest_path);
    let source = read_manifest_source(&manifest_path)?;
    if source.manifest.package.is_none() {
        return Ok(0);
    }
    let mut crate_diags = Vec::new();
    check_cargo_manifest(&manifest_rel, &source, config, &mut crate_diags);
    let src_dir = normalize_lexical_path(&crate_dir.join("src"));
    let mut rs_files = Vec::new();
    if src_dir.is_dir() {
        collect_rs_files(&src_dir, &mut rs_files)?;
    }
    let target_roots = manifest_target_roots(&manifest_path, crate_dir, &source)?;
    rs_files.extend(target_roots.iter().cloned());
    rs_files.sort();
    rs_files.dedup();

    let walk = CrateWalk {
        workspace_root,
        src_dir: &src_dir,
        config,
        crate_name: source.crate_name(),
        target_roots: &target_roots,
    };
    let mut contexts = FxHashMap::default();
    let parsed = parse_crate_files(&walk, rs_files, &mut contexts, &mut crate_diags)?;
    let parsed_files = parsed.files;
    for file in &parsed.test_files {
        if let Some(context) = contexts.get_mut(&relative_display(workspace_root, file)) {
            context.test_file = true;
        }
    }
    let mut rs_files: Vec<_> = parsed.visited.into_iter().collect();
    rs_files.sort();

    let index = StructIndex::new(&rs_files, &parsed_files);
    let crate_names = CrateNames::collect(&rs_files, &parsed_files);
    for file in &rs_files {
        if let Some(ast) = parsed_files.get(file) {
            let rel_path = relative_display(workspace_root, file);
            let pass_ctx = FilePassCtx {
                rel_path: &rel_path,
                path: file,
                ast,
                crate_names: &crate_names,
                index: Some(&index),
            };
            for pass in FILE_PASSES {
                pass(&pass_ctx, &mut crate_diags);
            }
        }
    }
    let crate_ctx = CratePassCtx {
        walk: &walk,
        index: &index,
        files: &rs_files,
        asts: &parsed_files,
    };
    for pass in CRATE_PASSES {
        pass(&crate_ctx, &mut crate_diags);
    }
    diagnostics.extend(settle_diagnostics(
        crate_diags,
        config,
        &contexts,
        workspace_root,
    )?);
    Ok(rs_files.len())
}

struct ParsedCrate {
    files: FxHashMap<PathBuf, syn::File>,
    visited: FxHashSet<PathBuf>,
    test_files: BTreeSet<PathBuf>,
}

pub(super) struct CrateWalk<'a> {
    pub(super) workspace_root: &'a Path,
    pub(super) src_dir: &'a Path,
    pub(super) config: &'a RustConfig,
    pub(super) crate_name: Option<&'a str>,
    pub(super) target_roots: &'a [PathBuf],
}

fn parse_crate_files(
    walk: &CrateWalk<'_>,
    rs_files: Vec<PathBuf>,
    contexts: &mut FxHashMap<String, SourceContext>,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<ParsedCrate, String> {
    let mut parsed = ParsedCrate {
        files: FxHashMap::default(),
        visited: FxHashSet::default(),
        test_files: BTreeSet::new(),
    };
    let mut pending: VecDeque<_> = rs_files.into_iter().collect();
    while let Some(file) = pending.pop_front() {
        if !parsed.visited.insert(file.clone()) {
            continue;
        }
        let top_module = top_module_of(walk.src_dir, &file);
        let layer = CrateLayer {
            crate_name: walk.crate_name,
            top_module: top_module.as_deref(),
        };
        let Some(ast) = check_source_file(
            walk.workspace_root,
            &file,
            walk.config,
            &layer,
            contexts,
            diagnostics,
        )?
        else {
            continue;
        };
        let file_is_test = parsed.test_files.contains(&file);
        for declared in declared_modules(
            &file,
            walk.target_roots.contains(&file),
            &ast,
            &walk.config.module_macros,
        ) {
            if declared.code == ModuleCode::Test || file_is_test {
                parsed.test_files.insert(declared.file.clone());
            }
            pending.push_back(declared.file);
        }
        parsed.files.insert(file, ast);
    }
    Ok(parsed)
}

fn manifest_target_roots(
    manifest_path: &Path,
    crate_dir: &Path,
    source: &ManifestSource,
) -> Result<Vec<PathBuf>, String> {
    let mut target_roots = Vec::new();
    for (_, target) in source.targets() {
        let Some(relative) = &target.get_ref().path else {
            continue;
        };
        let target_file = normalize_lexical_path(&crate_dir.join(relative));
        if !target_file.is_file() {
            return Err(format!(
                "{}: target path '{relative}' is not a file; point [lib].path or [[bin]].path at an existing Rust source file",
                manifest_path.display()
            ));
        }
        target_roots.push(target_file);
    }
    let build_script = normalize_lexical_path(&crate_dir.join("build.rs"));
    if build_script.is_file() {
        target_roots.push(build_script);
    }
    Ok(target_roots)
}

fn top_module_of(src_dir: &Path, file: &Path) -> Option<String> {
    let Ok(relative) = file.strip_prefix(src_dir) else {
        return None;
    };
    let head = relative.components().next()?.as_os_str().to_str()?;
    Some(head.strip_suffix(".rs").unwrap_or(head).to_owned())
}

fn settle_diagnostics(
    raw: Vec<RustDiagnostic>,
    config: &RustConfig,
    contexts: &FxHashMap<String, SourceContext>,
    scan_root: &Path,
) -> Result<Vec<RustDiagnostic>, String> {
    let mut settled = Vec::with_capacity(raw.len());
    for mut diag in raw {
        let Some(known) = row(diag.rule_id) else {
            return Err(format!(
                "engine bug: rule '{}' reported for {} is missing from the Rust rule catalog",
                diag.rule_id, diag.file
            ));
        };
        let Some(level) = config.level_of(known.id) else {
            return Err(format!(
                "engine bug: rule '{}' has no configured level",
                known.id
            ));
        };
        if level.level == Severity::Off {
            continue;
        }
        let absolute = normalize_lexical_path(&scan_root.join(&diag.file));
        let owner_candidate = match absolute.strip_prefix(&config.root_dir) {
            Ok(rel) => Some(relative_display(Path::new(""), rel)),
            Err(_) => None,
        };
        let candidates: Vec<&str> = owner_candidate
            .as_deref()
            .filter(|rel| *rel != diag.file)
            .into_iter()
            .chain(std::iter::once(diag.file.as_str()))
            .collect();
        if !level.scope.matches_candidates(&candidates) {
            continue;
        }
        let skips_tests = matches!(known.scope_policy, ScopePolicy::AuthoredSource);
        if let Some(context) = contexts.get(&diag.file)
            && (context.generated || (skips_tests && context.in_test_code(diag.line)))
        {
            continue;
        }
        diag.severity = diag.severity.min(level.level);
        settled.push(diag);
    }
    Ok(settled)
}

fn check_source_file(
    workspace_root: &Path,
    file_path: &Path,
    config: &RustConfig,
    layer: &CrateLayer<'_>,
    contexts: &mut FxHashMap<String, SourceContext>,
    diagnostics: &mut Vec<RustDiagnostic>,
) -> Result<Option<syn::File>, String> {
    let rel_path = relative_display(workspace_root, file_path);
    let source = fs::read_to_string(file_path)
        .map_err(|err| format!("failed to read {}: {err}", file_path.display()))?;
    check_file_surface(&rel_path, &source, diagnostics);
    let parsed = match syn::parse_file(&source) {
        Ok(ast) => {
            check_module_boundaries(&rel_path, file_path, &ast, config, layer, diagnostics);
            Some(ast)
        }
        Err(err) => {
            diagnostics.push(RustDiagnostic::error(
                rel_path.clone(),
                err.span().start().line.max(1),
                "rust/syntax-error",
                format!("Failed to parse Rust source: {err}"),
            ));
            None
        }
    };
    contexts.insert(
        rel_path.clone(),
        SourceContext::new(&rel_path, &source, parsed.as_ref()),
    );
    Ok(parsed)
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|err| format!("failed to read {}: {err}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|err| format!("failed to read directory entry: {err}"))?
            .path();
        let skip_dir = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.starts_with('.') || ["target", "node_modules", "vendor", "dist"].contains(&n)
        });
        if path.is_dir() && !skip_dir {
            collect_rs_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(normalize_lexical_path(&path));
        }
    }
    Ok(())
}

pub(super) fn relative_display(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}
