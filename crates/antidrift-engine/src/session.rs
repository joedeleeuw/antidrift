use std::path::{Path, PathBuf};

use antidrift_kernel::directives::effective_token_start;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::SourceFile;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrslint::linter::{Options, lint_files};
use tsrslint::rule::Rule;

use crate::headless_host::{
    BoundProgram, ProgramBuilderEnv, base_fs, collect_missing_bound_files,
    suppress_program_diagnostics_enabled,
};
use crate::rule_catalog::{RequestedRule, RuleCatalog, RuleRequest};
use crate::runner::{collect_lintable_files, is_supported_file};

#[derive(Clone)]
pub struct Finding {
    pub rule: String,
    pub message: String,
    pub start: u32,
    pub end: u32,
}

struct Batch {
    files: Vec<String>,
    bound: Option<BoundProgram>,
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
            missing: Vec::new(),
            linted: FxHashSet::default(),
        }
    }
}

pub(crate) struct Session {
    pub(crate) env: ProgramBuilderEnv,
    catalog: RuleCatalog,
    families: Vec<Family>,
    slots: FxHashMap<String, (usize, Slot)>,
    findings: FxHashMap<String, Vec<(String, Finding)>>,
}

impl Session {
    pub(crate) fn new(cwd: &str) -> Result<Self, String> {
        tsrs_checker::links::set_sparse_id_pages(true);
        let catalog = RuleCatalog::load(Path::new(cwd))?;
        let cwd = tspath::normalize_path(cwd);
        let env = ProgramBuilderEnv::new(base_fs(None), &cwd);
        let mut session = Self {
            env,
            catalog,
            families: Vec::new(),
            slots: FxHashMap::default(),
            findings: FxHashMap::default(),
        };
        let walked = collect_lintable_files(&[PathBuf::from(&cwd)], Path::new(&cwd))?;
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
        requests: &[RuleRequest],
    ) -> Result<Vec<Finding>, String> {
        if requests.is_empty() || !is_requestable_file(Path::new(file_path)) {
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

    fn build_configured(&mut self, family: usize, index: usize) -> Result<(), String> {
        let (config_file_name, batch) = &self.families[family].configured[index];
        if batch.bound.is_some() {
            return Ok(());
        }
        let bound = self
            .env
            .configured_program(
                config_file_name,
                &batch.files,
                suppress_program_diagnostics_enabled(),
            )
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
        rules: &[RequestedRule],
    ) -> Result<(), String> {
        match slot {
            Slot::Configured(index) => self.build_configured(family, index)?,
            Slot::Inferred => self.build_inferred(family)?,
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
        for sf in &bound.source_files {
            self.findings
                .entry(tspath::normalize_slashes(sf.file_name()))
                .or_default();
        }
        for group in group_rule_passes(&missing) {
            let instances: Vec<&'static dyn Rule> = group.iter().map(|&(_, rule)| rule).collect();
            let group_keys: FxHashSet<&str> = group.iter().map(|&(key, _)| key).collect();
            let pass_missing: Vec<&RequestedRule> = missing
                .iter()
                .copied()
                .filter(|req| group_keys.contains(req.rule_key.as_str()))
                .collect();
            for (file, message_id, finding) in record(bound, &instances) {
                record_matched_findings(
                    &mut self.findings,
                    &pass_missing,
                    &file,
                    message_id,
                    &finding,
                )?;
            }
        }
        batch
            .linted
            .extend(missing.iter().map(|requested| requested.identity.clone()));
        Ok(())
    }
}

fn group_rule_passes<'a>(missing: &[&'a RequestedRule]) -> Vec<Vec<(&'a str, &'static dyn Rule)>> {
    let mut unique: Vec<(&'a str, &'static dyn Rule)> = Vec::new();
    let mut seen_keys = FxHashSet::default();
    for requested in missing {
        if seen_keys.insert(requested.rule_key.as_str()) {
            unique.push((requested.rule_key.as_str(), requested.rule));
        }
    }
    let mut passes: Vec<Vec<(&'a str, &'static dyn Rule)>> = Vec::new();
    for (rule_key, rule) in unique {
        if let Some(pass) = passes.iter_mut().find(|pass| {
            pass.iter()
                .all(|(_, existing)| existing.name() != rule.name())
        }) {
            pass.push((rule_key, rule));
        } else {
            passes.push(vec![(rule_key, rule)]);
        }
    }
    passes
}

fn record_matched_findings(
    findings: &mut FxHashMap<String, Vec<(String, Finding)>>,
    missing: &[&RequestedRule],
    file: &str,
    message_id: &str,
    finding: &Finding,
) -> Result<(), String> {
    let mut matched_rule = false;
    for requested in missing {
        if requested.rule.name() != finding.rule {
            continue;
        }
        matched_rule = true;
        if requested
            .tier
            .is_none_or(|tier| tier.message_id() == message_id)
        {
            let mut item = finding.clone();
            item.rule.clone_from(&requested.output_name);
            findings
                .entry(file.to_owned())
                .or_default()
                .push((requested.identity.clone(), item));
        }
    }
    if !matched_rule {
        return Err(format!(
            "{} reported under a rule id that was not requested",
            finding.rule
        ));
    }
    Ok(())
}

fn is_requestable_file(path: &Path) -> bool {
    is_supported_file(path)
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(tspath::is_declaration_file_name)
}

fn utf16_offset(source_text: &str, byte_offset: u32) -> u32 {
    let clamped = usize::try_from(byte_offset)
        .unwrap_or(source_text.len())
        .min(source_text.len());
    u32::try_from(
        source_text
            .get(..clamped)
            .unwrap_or("")
            .encode_utf16()
            .count(),
    )
    .unwrap_or(0)
}

fn record(
    bound: &BoundProgram,
    rules: &[&'static dyn Rule],
) -> Vec<(String, &'static str, Finding)> {
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
    reported
        .iter()
        .map(|item| {
            let file = tspath::normalize_slashes(item.file.file_name());
            let source_text = item.file.text();
            let start_byte = effective_token_start(source_text, item.pos, item.end);
            let end_byte = u32::try_from(item.end.max(0)).unwrap_or(start_byte);
            let finding = Finding {
                rule: item.rule_name.to_owned(),
                message: item.message.description.clone(),
                start: utf16_offset(source_text, start_byte),
                end: utf16_offset(source_text, end_byte),
            };
            (file, item.message.id, finding)
        })
        .collect()
}
