use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use antidrift_kernel::diagnostic::{RuleDiagnostic, apply_fixes};
use antidrift_kernel::directives::DirectiveSet;
use antidrift_kernel::provenance::relative_to_cwd;
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_kernel::span_index::LineIndex;
use antidrift_kernel::suppressions::SuppressionsTable;
use ignore::WalkBuilder;
use rustc_hash::FxHashMap;
use tsrs_ast::SourceFile;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::linter::{Options, lint_files};
use tsrslint::rule::{ReportedDiagnostic, Rule};

use crate::batch::reported_to_rule_diagnostic;
use crate::cli::CliArgs;
use crate::format::format_diagnostics;
use crate::headless::default_workspace_rules;
use crate::headless_host::{BoundProgram, ProgramBuilderEnv, collect_missing_bound_files};

pub(crate) fn run_workspace(args: &CliArgs) -> Result<i32, String> {
    tsrs_checker::links::set_sparse_id_pages(true);
    let cwd = std::env::current_dir()
        .map_err(|err| format!("failed to read current directory: {err}"))?;
    let registry_base = args
        .paths
        .first()
        .map(|p| {
            if p.is_absolute() {
                p.clone()
            } else {
                cwd.join(p)
            }
        })
        .and_then(|p| {
            if p.is_file() {
                p.parent().map(Path::to_path_buf)
            } else {
                Some(p)
            }
        })
        .unwrap_or_else(|| cwd.clone());
    let registries = PolicyRegistries::load_from_repo(&registry_base)?;
    let files = collect_lintable_files(&args.paths, &cwd)?;
    if files.is_empty() {
        return handle_suppressions_and_format(args, &BTreeMap::new());
    }
    let active_rules = default_workspace_rules(&registries)?;
    let script_rules: Vec<&'static dyn Rule> = active_rules
        .iter()
        .copied()
        .filter(|rule| !antidrift_rules::is_typescript_only_rule(rule.name()))
        .collect();
    let cwd_norm = tspath::normalize_slashes(&cwd.to_string_lossy());
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
    let env = ProgramBuilderEnv::new(fs, &cwd_norm);
    let normalized_files: Vec<String> = files
        .iter()
        .map(|path| tspath::normalize_slashes(&path.to_string_lossy()))
        .collect();
    let (programs, mut unmatched) = env.group_files_by_tsconfig(&normalized_files);
    let mut diagnostics_by_file: BTreeMap<String, Vec<RuleDiagnostic>> = BTreeMap::new();
    for (config_file_name, config_files) in &programs {
        let bound = env
            .run_configured_program(config_file_name, config_files, true)
            .map_err(|diags| {
                let messages: Vec<String> = diags
                    .into_iter()
                    .map(|diag| {
                        format!(
                            "{}: {}",
                            diag.file_path.as_deref().unwrap_or(config_file_name),
                            diag.message.description
                        )
                    })
                    .collect();
                format!("failed to load {config_file_name}: {}", messages.join("; "))
            })?;
        collect_missing_bound_files(&bound.source_files, config_files, &mut unmatched);
        lint_bound_program(
            &bound,
            &active_rules,
            &script_rules,
            &cwd_norm,
            args,
            &mut diagnostics_by_file,
        )?;
    }
    if !unmatched.is_empty() {
        let bound = env.build_inferred_program(&unmatched);
        lint_bound_program(
            &bound,
            &active_rules,
            &script_rules,
            &cwd_norm,
            args,
            &mut diagnostics_by_file,
        )?;
    }

    handle_suppressions_and_format(args, &diagnostics_by_file)
}

fn lint_bound_program(
    bound: &BoundProgram,
    active_rules: &[&'static dyn Rule],
    script_rules: &[&'static dyn Rule],
    cwd_norm: &str,
    args: &CliArgs,
    diagnostics_by_file: &mut BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<(), String> {
    let mut ts_files: Vec<P<SourceFile>> = Vec::new();
    let mut js_files: Vec<P<SourceFile>> = Vec::new();
    for &sf in &bound.source_files {
        if tspath::has_ts_file_extension(sf.file_name()) {
            ts_files.push(sf);
        } else {
            js_files.push(sf);
        }
    }
    let mut reported_by_file: FxHashMap<String, Vec<ReportedDiagnostic>> = FxHashMap::default();
    if !ts_files.is_empty() && !active_rules.is_empty() {
        for item in lint_files(bound.program, &ts_files, active_rules, &Options::default()) {
            reported_by_file
                .entry(tspath::normalize_slashes(item.file.file_name()))
                .or_default()
                .push(item);
        }
    }
    if !js_files.is_empty() && !script_rules.is_empty() {
        for item in lint_files(bound.program, &js_files, script_rules, &Options::default()) {
            reported_by_file
                .entry(tspath::normalize_slashes(item.file.file_name()))
                .or_default()
                .push(item);
        }
    }
    let severities = FxHashMap::default();
    for &sf in &bound.source_files {
        let full_norm = tspath::normalize_slashes(sf.file_name());
        let source_text = sf.text();
        let line_index = LineIndex::new(source_text);
        let mut directives = DirectiveSet::from_source(source_text, &line_index);
        let raw_diags: Vec<RuleDiagnostic> = reported_by_file
            .remove(&full_norm)
            .unwrap_or_default()
            .iter()
            .map(|item| reported_to_rule_diagnostic(item, source_text, &line_index, &severities))
            .collect();
        let filtered = directives.filter_diagnostics(
            raw_diags,
            args.report_unused_directives,
            source_text,
            &line_index,
        );
        if args.fix
            && let Some(fixed) = apply_fixes(source_text, &filtered)
        {
            fs::write(&full_norm, fixed)
                .map_err(|err| format!("failed to write {full_norm}: {err}"))?;
        }
        if !filtered.is_empty() {
            diagnostics_by_file.insert(relative_to_cwd(cwd_norm, &full_norm), filtered);
        }
    }
    Ok(())
}

fn handle_suppressions_and_format(
    args: &CliArgs,
    diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<i32, String> {
    let mut suppressions = SuppressionsTable::load(&args.suppressions_path)?;
    if !args.suppress_rules.is_empty() {
        suppressions.suppress_rules(diagnostics_by_file, &args.suppress_rules);
        suppressions.save(&args.suppressions_path)?;
        return Ok(0);
    }
    if args.prune_suppressions {
        suppressions.prune(diagnostics_by_file);
        suppressions.save(&args.suppressions_path)?;
        return Ok(0);
    }

    let unsuppressed_diagnostics = suppressions.evaluate(diagnostics_by_file);
    let formatted = format_diagnostics(args.format, &unsuppressed_diagnostics)?;
    if !formatted.is_empty() {
        print!("{formatted}");
    }
    if !unsuppressed_diagnostics.is_empty() {
        return Ok(1);
    }
    Ok(0)
}

pub(crate) fn collect_lintable_files(
    paths: &[PathBuf],
    cwd: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut collected = Vec::new();
    for root in paths {
        let full = if root.is_absolute() {
            root.clone()
        } else {
            cwd.join(root)
        };
        if !full.exists() {
            return Err(format!("path does not exist: {}", root.display()));
        }
        if full.is_file() {
            if is_supported_file(&full) {
                collected.push(full);
            }
            continue;
        }
        let walker = WalkBuilder::new(&full).standard_filters(true).build();
        for entry in walker {
            let entry = entry.map_err(|err| format!("failed to walk {}: {err}", full.display()))?;
            let path = entry.path();
            if path.is_file() && is_supported_file(path) {
                collected.push(path.to_path_buf());
            }
        }
    }
    collected.sort();
    collected.dedup();
    Ok(collected)
}

pub(crate) fn is_supported_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    tspath::has_implementation_ts_file_extension(name) || tspath::has_js_file_extension(name)
}
