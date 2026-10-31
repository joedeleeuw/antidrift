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

struct Batch {
    files: Vec<String>,
    bound: Option<BoundProgram>,
    missing: Vec<String>,
    linted: FxHashSet<&'static str>,
}

struct Family {
    configured: Vec<(String, Batch)>,
    inferred: Batch,
}

#[derive(Clone, Copy)]
enum Slot {
    Configured(usize),
    Inferred,
}

impl Batch {
    fn of(files: Vec<String>) -> Self {
        Self {
            files,
            bound: None,
            missing: Vec::new(),
            linted: FxHashSet::default(),
        }
    }
}

pub(crate) struct Session {
    cwd: String,
    pub(crate) env: ProgramBuilderEnv,
    rules: FxHashMap<&'static str, &'static dyn Rule>,
    families: Vec<Family>,
    slots: FxHashMap<String, (usize, Slot)>,
    findings: FxHashMap<String, Vec<Finding>>,
}

impl Session {
    pub(crate) fn new(cwd: &str) -> Result<Self, String> {
        tsrs_checker::links::set_sparse_id_pages(true);
        let registries = PolicyRegistries::load_from_repo(Path::new(cwd))?;
        let mut catalog = default_workspace_rules(&registries)?;
        for rule in antidrift_rules::all_rules() {
            push_unique_rule(&mut catalog, rule);
        }
        let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(Arc::new(osvfs::fs()))));
        let cwd = tspath::normalize_slashes(cwd);
        let mut session = Self {
            env: ProgramBuilderEnv::new(fs, &cwd),
            rules: catalog
                .into_iter()
                .map(|rule| (rule.name(), rule))
                .collect(),
            families: Vec::new(),
            slots: FxHashMap::default(),
            findings: FxHashMap::default(),
            cwd,
        };
        let walked =
            collect_lintable_files(&[PathBuf::from(&session.cwd)], Path::new(&session.cwd))?;
        let workspace: Vec<String> = walked
            .iter()
            .map(|path| tspath::normalize_slashes(&path.to_string_lossy()))
            .collect();
        session.add_family(&workspace);
        Ok(session)
    }

    pub(crate) fn lint_file(
        &mut self,
        file_path: &str,
        rule_names: &[String],
    ) -> Result<Vec<Finding>, String> {
        if !is_supported_file(Path::new(file_path)) {
            return Ok(Vec::new());
        }
        let rules = rule_names
            .iter()
            .map(|name| {
                self.rules.get(name.as_str()).copied().ok_or_else(|| {
                    format!("{name} is not an antidrift rule; the plugin registers only the rules the addon lists")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let normalized = tspath::normalize_slashes(file_path);
        let (family, slot) = match self.slots.get(&normalized) {
            Some(&found) => found,
            None => {
                self.add_family(std::slice::from_ref(&normalized));
                self.slots[&normalized]
            }
        };
        self.lint_slot(family, slot, &rules)?;
        if let Slot::Configured(index) = slot
            && self.families[family].configured[index]
                .1
                .missing
                .contains(&normalized)
        {
            self.lint_slot(family, Slot::Inferred, &rules)?;
        }
        let wanted: FxHashSet<&str> = rules.iter().map(|rule| rule.name()).collect();
        self.findings
            .get(&normalized)
            .map(|findings| {
                findings
                    .iter()
                    .filter(|finding| wanted.contains(finding.rule.as_str()))
                    .cloned()
                    .collect()
            })
            .ok_or_else(|| {
                format!("{normalized} was linted but is missing from every program built for it")
            })
    }

    fn add_family(&mut self, files: &[String]) {
        let (programs, unmatched) = self.env.group_files_by_tsconfig(files);
        let index = self.families.len();
        for (position, (_, config_files)) in programs.iter().enumerate() {
            for file in config_files {
                self.slots
                    .insert(file.clone(), (index, Slot::Configured(position)));
            }
        }
        for file in &unmatched {
            self.slots.insert(file.clone(), (index, Slot::Inferred));
        }
        self.families.push(Family {
            configured: programs
                .into_iter()
                .map(|(config_file_name, config_files)| (config_file_name, Batch::of(config_files)))
                .collect(),
            inferred: Batch::of(unmatched),
        });
    }

    fn build_configured(&mut self, family: usize, index: usize) -> Result<(), String> {
        let (config_file_name, batch) = &self.families[family].configured[index];
        if batch.bound.is_some() {
            return Ok(());
        }
        let bound = self
            .env
            .configured_program(config_file_name, &batch.files, true)
            .map_err(|diagnostics| {
                let messages: Vec<String> = diagnostics
                    .into_iter()
                    .map(|diagnostic| diagnostic.message.description)
                    .collect();
                format!("failed to load {config_file_name}: {}", messages.join("; "))
            })?;
        let batch = &mut self.families[family].configured[index].1;
        collect_missing_bound_files(&bound.source_files, &batch.files, &mut batch.missing);
        batch.bound = Some(bound);
        Ok(())
    }

    fn build_inferred(&mut self, family: usize) -> Result<(), String> {
        if self.families[family].inferred.bound.is_some() {
            return Ok(());
        }
        for index in 0..self.families[family].configured.len() {
            self.build_configured(family, index)?;
        }
        let selected = &self.families[family];
        let roots: Vec<String> = selected
            .inferred
            .files
            .iter()
            .chain(
                selected
                    .configured
                    .iter()
                    .flat_map(|(_, batch)| &batch.missing),
            )
            .cloned()
            .collect();
        if roots.is_empty() {
            return Ok(());
        }
        let bound = self.env.inferred_program(&roots);
        self.families[family].inferred.bound = Some(bound);
        Ok(())
    }

    fn lint_slot(
        &mut self,
        family: usize,
        slot: Slot,
        rules: &[&'static dyn Rule],
    ) -> Result<(), String> {
        match slot {
            Slot::Configured(index) => self.build_configured(family, index)?,
            Slot::Inferred => self.build_inferred(family)?,
        }
        let batch = match slot {
            Slot::Configured(index) => &mut self.families[family].configured[index].1,
            Slot::Inferred => &mut self.families[family].inferred,
        };
        let missing: Vec<&'static dyn Rule> = rules
            .iter()
            .copied()
            .filter(|rule| !batch.linted.contains(rule.name()))
            .collect();
        let Some(bound) = batch.bound.as_ref().filter(|_| !missing.is_empty()) else {
            return Ok(());
        };
        let recorded = record(bound, &missing);
        batch.linted.extend(missing.iter().map(|rule| rule.name()));
        for sf in &bound.source_files {
            self.findings
                .entry(tspath::normalize_slashes(sf.file_name()))
                .or_default();
        }
        for (file, finding) in recorded {
            self.findings.entry(file).or_default().push(finding);
        }
        Ok(())
    }
}

fn record(bound: &BoundProgram, rules: &[&'static dyn Rule]) -> Vec<(String, Finding)> {
    let (ts_files, js_files): (Vec<P<SourceFile>>, Vec<P<SourceFile>>) = bound
        .source_files
        .iter()
        .copied()
        .partition(|sf| tspath::has_ts_file_extension(sf.file_name()));
    let script_rules: Vec<&'static dyn Rule> = rules
        .iter()
        .copied()
        .filter(|rule| !antidrift_rules::is_typescript_only_rule(rule.name()))
        .collect();
    let mut reported = lint_files(bound.program, &ts_files, rules, &Options::default());
    reported.extend(lint_files(
        bound.program,
        &js_files,
        &script_rules,
        &Options::default(),
    ));
    let mut line_indexes: FxHashMap<String, LineIndex> = FxHashMap::default();
    let severities = FxHashMap::default();
    reported
        .iter()
        .map(|item| {
            let file = tspath::normalize_slashes(item.file.file_name());
            let source_text = item.file.text();
            let line_index = line_indexes
                .entry(file.clone())
                .or_insert_with(|| LineIndex::new(source_text));
            let diagnostic =
                reported_to_rule_diagnostic(item, source_text, line_index, &severities);
            let finding = Finding {
                rule: diagnostic.rule_id,
                message: diagnostic.message,
                location: diagnostic.location,
            };
            (file, finding)
        })
        .collect()
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
