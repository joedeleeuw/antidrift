use std::path::{Path, PathBuf};
use std::sync::Arc;

use antidrift_kernel::registries::PolicyRegistries;
use antidrift_kernel::span_index::{DiagnosticLocation, LineIndex};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::SourceFile;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::linter::{Options, lint_files};
use tsrslint::rule::Rule;

use crate::batch::reported_to_rule_diagnostic;
use crate::headless_host::{BoundProgram, ProgramBuilderEnv, collect_missing_bound_files};
use crate::rule_plan::{default_workspace_rules, push_unique_rule};
use crate::runner::{collect_lintable_files, is_supported_file};

#[derive(Clone)]
pub struct Finding {
    pub rule: String,
    pub message: String,
    pub location: DiagnosticLocation,
}

pub(crate) struct Session {
    cwd: String,
    pub(crate) env: ProgramBuilderEnv,
    rules: Vec<&'static dyn Rule>,
    script_rules: Vec<&'static dyn Rule>,
    findings: FxHashMap<String, Vec<Finding>>,
    workspace_linted: bool,
}

impl Session {
    pub(crate) fn new(cwd: &str) -> Result<Self, String> {
        tsrs_checker::links::set_sparse_id_pages(true);
        let registries = PolicyRegistries::load_from_repo(Path::new(cwd))?;
        let mut rules = default_workspace_rules(&registries)?;
        for rule in antidrift_rules::all_rules() {
            push_unique_rule(&mut rules, rule);
        }
        let script_rules = rules
            .iter()
            .copied()
            .filter(|rule| !antidrift_rules::is_typescript_only_rule(rule.name()))
            .collect();
        let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
        let cwd = tspath::normalize_slashes(cwd);
        Ok(Self {
            env: ProgramBuilderEnv::new(fs, &cwd),
            cwd,
            rules,
            script_rules,
            findings: FxHashMap::default(),
            workspace_linted: false,
        })
    }

    pub(crate) fn lint_file(&mut self, file_path: &str) -> Result<Vec<Finding>, String> {
        if !is_supported_file(Path::new(file_path)) {
            return Ok(Vec::new());
        }
        let normalized = tspath::normalize_slashes(file_path);
        if !self.workspace_linted {
            let files = collect_lintable_files(&[PathBuf::from(&self.cwd)], Path::new(&self.cwd))?;
            let workspace: Vec<String> = files
                .iter()
                .map(|path| tspath::normalize_slashes(&path.to_string_lossy()))
                .collect();
            self.lint_paths(&workspace)?;
            self.workspace_linted = true;
        }
        if !self.findings.contains_key(&normalized) {
            self.lint_paths(std::slice::from_ref(&normalized))?;
        }
        self.findings.get(&normalized).cloned().ok_or_else(|| {
            format!("{normalized} was linted but is missing from every program built for it")
        })
    }

    fn lint_paths(&mut self, files: &[String]) -> Result<(), String> {
        let (programs, mut unmatched) = self.env.group_files_by_tsconfig(files);
        for (config_file_name, config_files) in &programs {
            let bound = self
                .env
                .configured_program(config_file_name, config_files, true)
                .map_err(|diagnostics| {
                    let messages: Vec<String> = diagnostics
                        .into_iter()
                        .map(|diagnostic| diagnostic.message.description)
                        .collect();
                    format!("failed to load {config_file_name}: {}", messages.join("; "))
                })?;
            collect_missing_bound_files(&bound.source_files, config_files, &mut unmatched);
            self.record(&bound);
        }
        if !unmatched.is_empty() {
            let bound = self.env.inferred_program(&unmatched);
            self.record(&bound);
        }
        Ok(())
    }

    fn record(&mut self, bound: &BoundProgram) {
        let (ts_files, js_files): (Vec<P<SourceFile>>, Vec<P<SourceFile>>) = bound
            .source_files
            .iter()
            .copied()
            .partition(|sf| tspath::has_ts_file_extension(sf.file_name()));
        let mut reported = lint_files(bound.program, &ts_files, &self.rules, &Options::default());
        reported.extend(lint_files(
            bound.program,
            &js_files,
            &self.script_rules,
            &Options::default(),
        ));
        let mut by_file: FxHashMap<String, Vec<Finding>> = FxHashMap::default();
        let mut line_indexes: FxHashMap<String, LineIndex> = FxHashMap::default();
        let severities = FxHashMap::default();
        for item in &reported {
            let file = tspath::normalize_slashes(item.file.file_name());
            let source_text = item.file.text();
            let line_index = line_indexes
                .entry(file.clone())
                .or_insert_with(|| LineIndex::new(source_text));
            let diagnostic =
                reported_to_rule_diagnostic(item, source_text, line_index, &severities);
            by_file.entry(file).or_default().push(Finding {
                rule: diagnostic.rule_id,
                message: diagnostic.message,
                location: diagnostic.location,
            });
        }
        for sf in &bound.source_files {
            let file = tspath::normalize_slashes(sf.file_name());
            let findings = by_file.remove(&file).unwrap_or_default();
            self.findings.insert(file, findings);
        }
    }
}

#[must_use]
pub fn rule_names() -> Vec<String> {
    let mut seen = FxHashSet::default();
    antidrift_rules::all_rules()
        .into_iter()
        .map(|rule| rule.name().to_owned())
        .filter(|name| seen.insert(name.clone()))
        .collect()
}
