use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use antidrift_kernel::diagnostic::{RuleDiagnostic, Severity, apply_fixes};
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
use crate::headless_host::{
    BoundProgram, ProgramBuilderEnv, collect_missing_bound_files,
    suppress_program_diagnostics_enabled,
};
use crate::rule_plan::{default_workspace_rules, instantiate_rule, push_unique_rule};

struct WorkspaceRuleSet {
    active_rules: Vec<&'static dyn Rule>,
    script_rules: Vec<&'static dyn Rule>,
    severities: FxHashMap<String, Severity>,
}

fn resolve_registry_base(paths: &[PathBuf], cwd: &Path) -> PathBuf {
    paths
        .first()
        .map(|p| normalize_fs_path(cwd, p))
        .and_then(|p| {
            if p.is_file() {
                p.parent().map(Path::to_path_buf)
            } else {
                Some(p)
            }
        })
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn resolve_workspace_rules(
    registries: &PolicyRegistries,
    rule_levels: &[(String, Severity)],
) -> Result<WorkspaceRuleSet, String> {
    let mut active_rules = default_workspace_rules(registries)?;
    let mut severities: FxHashMap<String, Severity> = FxHashMap::default();
    for (rule_id, level) in rule_levels {
        let Some(inst) = instantiate_rule(rule_id, None)? else {
            return Err(format!("unknown rule '{rule_id}' in --rule"));
        };
        if *level == Severity::Off {
            active_rules.retain(|rule| rule.name() != rule_id);
            severities.remove(rule_id);
        } else {
            push_unique_rule(&mut active_rules, inst);
            severities.insert(rule_id.clone(), *level);
        }
    }
    let script_rules = active_rules
        .iter()
        .copied()
        .filter(|rule| !antidrift_rules::is_typescript_only_rule(rule.name()))
        .collect();
    Ok(WorkspaceRuleSet {
        active_rules,
        script_rules,
        severities,
    })
}

pub(crate) fn run_workspace(args: &CliArgs) -> Result<i32, String> {
    tsrs_checker::links::set_sparse_id_pages(true);
    let cwd = std::env::current_dir()
        .map_err(|err| format!("failed to read current directory: {err}"))?;
    let registries = PolicyRegistries::load_from_repo(&resolve_registry_base(&args.paths, &cwd))?;
    let rule_set = resolve_workspace_rules(&registries, &args.rule_levels)?;
    let mut files = collect_lintable_files(&args.paths, &cwd)?;
    files.retain(|path| !registries.is_generated_path(path));
    if files.is_empty() {
        return handle_suppressions_and_format(args, &BTreeMap::new());
    }
    let cwd_norm = tspath::normalize_path(&cwd.to_string_lossy());
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
    let mut env = ProgramBuilderEnv::new(fs, &cwd_norm);
    let normalized_files: Vec<String> = files
        .iter()
        .map(|path| tspath::normalize_path(&path.to_string_lossy()))
        .collect();
    let (programs, mut unmatched) = env.group_files_by_tsconfig(&normalized_files);
    let mut diagnostics_by_file: BTreeMap<String, Vec<RuleDiagnostic>> = BTreeMap::new();
    let suppress_diags = suppress_program_diagnostics_enabled();
    for (config_file_name, config_files) in &programs {
        let bound = env
            .configured_program(config_file_name, config_files, suppress_diags)
            .map_err(|diags| {
                let messages: Vec<String> = diags
                    .into_iter()
                    .map(|diag| diag.message.description)
                    .collect();
                format!("failed to load {config_file_name}: {}", messages.join("; "))
            })?;
        collect_missing_bound_files(&bound.source_files, config_files, &mut unmatched);
        lint_bound_program(&bound, &rule_set, &cwd_norm, args, &mut diagnostics_by_file)?;
    }
    if !unmatched.is_empty() {
        let bound = env.inferred_program(&unmatched);
        lint_bound_program(&bound, &rule_set, &cwd_norm, args, &mut diagnostics_by_file)?;
    }
    handle_suppressions_and_format(args, &diagnostics_by_file)
}

fn lint_bound_program(
    bound: &BoundProgram,
    rule_set: &WorkspaceRuleSet,
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
    if !ts_files.is_empty() && !rule_set.active_rules.is_empty() {
        for item in lint_files(
            bound.program,
            &ts_files,
            &rule_set.active_rules,
            &Options::default(),
        ) {
            reported_by_file
                .entry(tspath::normalize_slashes(item.file.file_name()))
                .or_default()
                .push(item);
        }
    }
    if !js_files.is_empty() && !rule_set.script_rules.is_empty() {
        for item in lint_files(
            bound.program,
            &js_files,
            &rule_set.script_rules,
            &Options::default(),
        ) {
            reported_by_file
                .entry(tspath::normalize_slashes(item.file.file_name()))
                .or_default()
                .push(item);
        }
    }
    for &sf in &bound.source_files {
        let full_norm = tspath::normalize_slashes(sf.file_name());
        let source_text = sf.text();
        let line_index = LineIndex::new(source_text);
        let mut directives = DirectiveSet::from_source(source_text, &line_index);
        let raw_diags: Vec<RuleDiagnostic> = reported_by_file
            .remove(&full_norm)
            .unwrap_or_default()
            .iter()
            .map(|item| {
                reported_to_rule_diagnostic(item, source_text, &line_index, &rule_set.severities)
            })
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
    let has_failing = unsuppressed_diagnostics.values().flatten().any(|diag| {
        diag.severity == Severity::Error || (args.deny_warnings && diag.severity == Severity::Warn)
    });
    Ok(i32::from(has_failing))
}

fn push_resolved_components(base: &mut PathBuf, path: &Path, resolve_links: bool, depth: u8) {
    if depth > 40 {
        return;
    }
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => {
                base.clear();
                base.push(prefix.as_os_str());
            }
            std::path::Component::RootDir => {
                base.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                while depth < 40
                    && let Ok(target) = fs::read_link(&*base)
                {
                    base.pop();
                    push_resolved_components(base, &target, true, depth + 1);
                }
                base.pop();
            }
            std::path::Component::Normal(part) => {
                base.push(part);
                while resolve_links
                    && depth < 40
                    && let Ok(target) = fs::read_link(&*base)
                {
                    base.pop();
                    push_resolved_components(base, &target, true, depth + 1);
                }
            }
        }
    }
}

fn normalize_fs_path(cwd: &Path, path: &Path) -> PathBuf {
    let rel = if path.is_absolute() {
        path.strip_prefix(cwd).unwrap_or(path)
    } else {
        path
    };
    let has_parent = rel
        .components()
        .any(|comp| matches!(comp, std::path::Component::ParentDir));
    let mut resolved = if rel.is_absolute() {
        PathBuf::new()
    } else {
        PathBuf::from(tspath::normalize_path(&cwd.to_string_lossy()))
    };
    push_resolved_components(&mut resolved, rel, has_parent, 0);
    PathBuf::from(tspath::normalize_path(&resolved.to_string_lossy()))
}

pub(crate) fn collect_lintable_files(
    paths: &[PathBuf],
    cwd: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut collected = Vec::new();
    for root in paths {
        let joined = if root.is_absolute() {
            root.clone()
        } else {
            cwd.join(root)
        };
        if !joined.exists() {
            return Err(format!("path does not exist: {}", root.display()));
        }
        let full = normalize_fs_path(cwd, root);
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
                collected.push(normalize_fs_path(cwd, path));
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
