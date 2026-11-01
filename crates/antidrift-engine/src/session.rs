use std::path::{Path, PathBuf};

use antidrift_kernel::span_index::{DiagnosticLocation, LineIndex};
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::SourceFile;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrs_vfs::osvfs;
use tsrslint::linter::{Options, lint_files};
use tsrslint::rule::Rule;

use crate::batch::reported_to_rule_diagnostic;
use crate::headless_host::{BoundProgram, ProgramBuilderEnv, base_fs, collect_missing_bound_files};
use crate::program_inputs::{FileStamp, matches_stamps, stamp_program_inputs};
use crate::rule_catalog::{RequestedRule, RuleCatalog, RuleRequest};
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
    stamps: FxHashMap<String, FileStamp>,
    validated_run: Option<String>,
    missing: Vec<String>,
    linted: FxHashSet<String>,
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
            stamps: FxHashMap::default(),
            validated_run: None,
            missing: Vec::new(),
            linted: FxHashSet::default(),
        }
    }

    fn validated(&self, run_id: Option<&str>) -> bool {
        run_id.is_some() && self.validated_run.as_deref() == run_id
    }

    fn matches(&self, overrides: &FxHashMap<String, String>, run_id: Option<&str>) -> bool {
        self.bound.as_ref().is_none_or(|bound| {
            matches_stamps(
                bound.program,
                &self.stamps,
                overrides,
                self.validated(run_id),
            )
        })
    }

    fn bind(&mut self, bound: BoundProgram, run_id: Option<&str>) -> Result<(), String> {
        self.stamps = if run_id.is_some() {
            FxHashMap::default()
        } else {
            stamp_program_inputs(bound.program)?
        };
        self.bound = Some(bound);
        self.mark_validated(run_id);
        Ok(())
    }

    fn mark_validated(&mut self, run_id: Option<&str>) {
        if let Some(run_id) = run_id {
            self.validated_run = Some(run_id.to_owned());
        }
    }
}

pub(crate) struct Session {
    cwd: String,
    pub(crate) env: ProgramBuilderEnv,
    catalog: RuleCatalog,
    families: Vec<Family>,
    slots: FxHashMap<String, (usize, Slot)>,
    findings: FxHashMap<String, Vec<(String, Finding)>>,
    source_overrides: FxHashMap<String, String>,
}

impl Session {
    pub(crate) fn new(cwd: &str) -> Result<Self, String> {
        tsrs_checker::links::set_sparse_id_pages(true);
        let catalog = RuleCatalog::load(Path::new(cwd))?;
        Self::with_overrides(cwd, catalog, FxHashMap::default())
    }

    fn with_overrides(
        cwd: &str,
        catalog: RuleCatalog,
        source_overrides: FxHashMap<String, String>,
    ) -> Result<Self, String> {
        let cwd = tspath::normalize_slashes(cwd);
        let env = ProgramBuilderEnv::new(base_fs(Some(&source_overrides)), &cwd);
        let mut session = Self {
            env,
            catalog,
            families: Vec::new(),
            slots: FxHashMap::default(),
            findings: FxHashMap::default(),
            source_overrides,
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

    fn batches_of(&self, normalized: &str) -> Vec<(usize, Slot)> {
        match self.slots.get(normalized).copied() {
            Some((family, Slot::Configured(index))) => {
                vec![(family, Slot::Configured(index)), (family, Slot::Inferred)]
            }
            Some((family, Slot::Inferred)) => vec![(family, Slot::Inferred)],
            None => Vec::new(),
        }
    }

    fn batch_mut(&mut self, family: usize, slot: Slot) -> &mut Batch {
        match slot {
            Slot::Configured(index) => &mut self.families[family].configured[index].1,
            Slot::Inferred => &mut self.families[family].inferred,
        }
    }

    fn batch(&self, family: usize, slot: Slot) -> &Batch {
        match slot {
            Slot::Configured(index) => &self.families[family].configured[index].1,
            Slot::Inferred => &self.families[family].inferred,
        }
    }

    fn refresh(
        &mut self,
        normalized: &str,
        source_text: &str,
        run_id: Option<&str>,
    ) -> Result<(), String> {
        let batches = self.batches_of(normalized);
        let disk_validated = !batches.is_empty()
            && batches
                .iter()
                .all(|&(family, slot)| self.batch(family, slot).validated(run_id));
        let mut overrides = self.source_overrides.clone();
        if !disk_validated || overrides.contains_key(normalized) {
            if osvfs::fs().read_file(normalized).as_deref() == Some(source_text) {
                overrides.remove(normalized);
            } else {
                overrides.insert(normalized.to_owned(), source_text.to_owned());
            }
        }
        let fresh = batches
            .iter()
            .all(|&(family, slot)| self.batch(family, slot).matches(&overrides, run_id));
        if fresh {
            self.source_overrides = overrides;
        } else {
            let cwd = self.cwd.clone();
            let catalog = std::mem::take(&mut self.catalog);
            *self = Self::with_overrides(&cwd, catalog, overrides)?;
        }
        for (family, slot) in self.batches_of(normalized) {
            self.batch_mut(family, slot).mark_validated(run_id);
        }
        Ok(())
    }

    pub(crate) fn lint_file(
        &mut self,
        file_path: &str,
        source_text: &str,
        run_id: Option<&str>,
        requests: &[RuleRequest],
    ) -> Result<Vec<Finding>, String> {
        if requests.is_empty() || !is_supported_file(Path::new(file_path)) {
            return Ok(Vec::new());
        }
        let mut names = FxHashSet::default();
        for request in requests {
            if !names.insert(request.name.as_str()) {
                return Err(format!(
                    "{} was requested twice for {file_path}; the plugin sends one options set per rule per file",
                    request.name
                ));
            }
        }
        let rules = requests
            .iter()
            .map(|request| self.catalog.resolve(request))
            .collect::<Result<Vec<_>, _>>()?;
        let normalized = tspath::normalize_slashes(file_path);
        self.refresh(&normalized, source_text, run_id)?;
        let (family, slot) = match self.slots.get(&normalized) {
            Some(&found) => found,
            None => {
                self.add_family(std::slice::from_ref(&normalized));
                self.slots[&normalized]
            }
        };
        self.lint_slot(family, slot, run_id, &rules)?;
        if let Slot::Configured(index) = slot
            && self.families[family].configured[index]
                .1
                .missing
                .contains(&normalized)
        {
            self.lint_slot(family, Slot::Inferred, run_id, &rules)?;
        }
        let wanted: FxHashSet<&str> = rules.iter().map(|rule| rule.identity.as_str()).collect();
        self.findings
            .get(&normalized)
            .map(|findings| {
                findings
                    .iter()
                    .filter(|(identity, _)| wanted.contains(identity.as_str()))
                    .map(|(_, finding)| finding.clone())
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

    fn build_configured(
        &mut self,
        family: usize,
        index: usize,
        run_id: Option<&str>,
    ) -> Result<(), String> {
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
        batch.bind(bound, run_id)
    }

    fn build_inferred(&mut self, family: usize, run_id: Option<&str>) -> Result<(), String> {
        if self.families[family].inferred.bound.is_some() {
            return Ok(());
        }
        for index in 0..self.families[family].configured.len() {
            self.build_configured(family, index, run_id)?;
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
        self.families[family].inferred.bind(bound, run_id)
    }

    fn lint_slot(
        &mut self,
        family: usize,
        slot: Slot,
        run_id: Option<&str>,
        rules: &[RequestedRule],
    ) -> Result<(), String> {
        match slot {
            Slot::Configured(index) => self.build_configured(family, index, run_id)?,
            Slot::Inferred => self.build_inferred(family, run_id)?,
        }
        let batch = match slot {
            Slot::Configured(index) => &mut self.families[family].configured[index].1,
            Slot::Inferred => &mut self.families[family].inferred,
        };
        let missing: Vec<&RequestedRule> = rules
            .iter()
            .filter(|requested| !batch.linted.contains(&requested.identity))
            .collect();
        let Some(bound) = batch.bound.as_ref().filter(|_| !missing.is_empty()) else {
            return Ok(());
        };
        let identities: FxHashMap<&str, &str> = missing
            .iter()
            .map(|requested| (requested.rule.name(), requested.identity.as_str()))
            .collect();
        let instances: Vec<&'static dyn Rule> =
            missing.iter().map(|requested| requested.rule).collect();
        let recorded = record(bound, &instances);
        batch
            .linted
            .extend(missing.iter().map(|requested| requested.identity.clone()));
        for sf in &bound.source_files {
            self.findings
                .entry(tspath::normalize_slashes(sf.file_name()))
                .or_default();
        }
        for (file, finding) in recorded {
            let identity = identities.get(finding.rule.as_str()).ok_or_else(|| {
                format!(
                    "{} reported under a rule id that was not requested",
                    finding.rule
                )
            })?;
            self.findings
                .entry(file)
                .or_default()
                .push(((*identity).to_owned(), finding));
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
