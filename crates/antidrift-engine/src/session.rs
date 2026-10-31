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
use crate::rule_plan::{
    all_scoped_rules, default_workspace_rules, instantiate_rule, push_unique_rule,
};
use crate::runner::{collect_lintable_files, is_supported_file};

#[derive(Clone)]
pub struct Finding {
    pub rule: String,
    pub message: String,
    pub location: DiagnosticLocation,
}

pub struct RuleRequest {
    pub name: String,
    pub options: Option<String>,
}

struct RequestedRule {
    identity: String,
    rule: &'static dyn Rule,
}

fn rule_identity(name: &str, options: Option<&serde_json::Value>) -> String {
    match options {
        Some(value) => format!("{name}\u{0}{value}"),
        None => name.to_owned(),
    }
}

fn decode_rule_options(
    name: &str,
    options: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(text) = options else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|err| format!("{name}: the host sent rule options that are not JSON: {err}"))?;
    let serde_json::Value::Array(items) = value else {
        return Err(format!(
            "{name}: the host must send rule options as the ESLint options array, got {value}"
        ));
    };
    match items.as_slice() {
        [] => Ok(None),
        [single] => Ok(Some(single.clone())),
        _ => Err(format!(
            "{name}: antidrift rules take one options object, the host sent {} values",
            items.len()
        )),
    }
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
    cwd: String,
    pub(crate) env: ProgramBuilderEnv,
    rules: FxHashMap<&'static str, &'static dyn Rule>,
    configured_rules: FxHashMap<String, &'static dyn Rule>,
    families: Vec<Family>,
    slots: FxHashMap<String, (usize, Slot)>,
    findings: FxHashMap<String, Vec<(String, Finding)>>,
}

impl Session {
    pub(crate) fn new(cwd: &str) -> Result<Self, String> {
        tsrs_checker::links::set_sparse_id_pages(true);
        let registries = PolicyRegistries::load_from_repo(Path::new(cwd))?;
        let mut catalog = default_workspace_rules(&registries)?;
        for rule in all_scoped_rules() {
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
            configured_rules: FxHashMap::default(),
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

    fn requested_rule(&mut self, request: &RuleRequest) -> Result<RequestedRule, String> {
        let name = request.name.as_str();
        let default = self.rules.get(name).copied().ok_or_else(|| {
            format!("{name} is not an antidrift rule; the plugin registers only the rules the addon lists")
        })?;
        let Some(options) = decode_rule_options(name, request.options.as_deref())? else {
            return Ok(RequestedRule {
                identity: rule_identity(name, None),
                rule: default,
            });
        };
        let identity = rule_identity(name, Some(&options));
        if let Some(&rule) = self.configured_rules.get(&identity) {
            return Ok(RequestedRule { identity, rule });
        }
        let rule = instantiate_rule(name, Some(&options))?
            .ok_or_else(|| format!("rule '{name}' is cataloged but no family factory builds it"))?;
        self.configured_rules.insert(identity.clone(), rule);
        Ok(RequestedRule { identity, rule })
    }

    pub(crate) fn lint_file(
        &mut self,
        file_path: &str,
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
            .map(|request| self.requested_rule(request))
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

#[must_use]
pub fn rule_names() -> Vec<String> {
    let mut seen = FxHashSet::default();
    antidrift_rules::all_rules()
        .into_iter()
        .map(|rule| rule.name().to_owned())
        .filter(|name| seen.insert(name.clone()))
        .collect()
}
