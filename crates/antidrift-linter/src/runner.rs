use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use antidrift_kernel::diagnostic::{RuleDiagnostic, apply_fixes};
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_kernel::semantic_facts::{SemanticFact, semantic_fact_to_json_line};
use antidrift_kernel::suppressions::SuppressionsTable;
use ignore::WalkBuilder;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use tsrs_core::tspath;

use crate::batch::lint_source_file;
use crate::cli::CliArgs;
use crate::format::format_diagnostics;
use crate::tsgolint_runner::default_workspace_rules;

pub(crate) fn run_workspace(args: &CliArgs) -> Result<i32, String> {
    tsrs_checker::links::set_sparse_id_pages(true);
    let cwd = std::env::current_dir()
        .map_err(|err| format!("failed to read current directory: {err}"))?;
    let registries = PolicyRegistries::load_from_repo(&cwd)?;
    let files = collect_lintable_files(&args.paths, &cwd)?;
    let active_rules = default_workspace_rules(&registries)?;
    let script_rules: Vec<&'static dyn tsrslint::rule::Rule> = active_rules
        .iter()
        .copied()
        .filter(|rule| !antidrift_rules::is_typescript_only_rule(rule.name()))
        .collect();
    let severities = FxHashMap::default();
    let cwd_norm = tspath::normalize_slashes(&cwd.to_string_lossy());

    let per_file_results: Vec<(String, Vec<RuleDiagnostic>, Vec<SemanticFact>)> = files
        .par_iter()
        .map(|path| {
            let source_text = fs::read_to_string(path)
                .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
            let rel_path = path
                .strip_prefix(&cwd)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let full_norm = tspath::normalize_slashes(&path.to_string_lossy());
            let rules_for_file = if tspath::has_ts_file_extension(&full_norm) {
                &active_rules
            } else {
                &script_rules
            };
            let diagnostics = lint_source_file(
                &full_norm,
                &source_text,
                &cwd_norm,
                rules_for_file,
                &severities,
                args.report_unused_directives,
            );
            if args.fix
                && let Some(fixed) = apply_fixes(&source_text, &diagnostics)
            {
                fs::write(path, fixed)
                    .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
            }
            Ok((rel_path, diagnostics, Vec::new()))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut diagnostics_by_file: BTreeMap<String, Vec<RuleDiagnostic>> = BTreeMap::new();
    let mut all_facts: Vec<SemanticFact> = Vec::new();
    for (file_path, diags, facts) in per_file_results {
        if !diags.is_empty() {
            diagnostics_by_file.insert(file_path, diags);
        }
        all_facts.extend(facts);
    }

    if let Some(facts_out) = &args.semantic_facts_out {
        write_semantic_facts(facts_out, &all_facts)?;
    }

    handle_suppressions_and_format(args, &diagnostics_by_file)
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

fn write_semantic_facts(path: &Path, facts: &[SemanticFact]) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    let mut buf = String::new();
    for fact in facts {
        buf.push_str(&semantic_fact_to_json_line(fact)?);
    }
    fs::write(path, buf).map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn collect_lintable_files(paths: &[PathBuf], cwd: &Path) -> Result<Vec<PathBuf>, String> {
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

fn is_supported_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name == "package.json"
        || tspath::has_implementation_ts_file_extension(name)
        || tspath::has_js_file_extension(name)
}
