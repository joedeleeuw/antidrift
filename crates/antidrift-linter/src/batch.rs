use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::sync::Arc;

use antidrift_kernel::diagnostic::{RuleDiagnostic, RuleFix, Severity, TextEdit, apply_fixes};
use antidrift_kernel::directives::{DirectiveSet, effective_token_start};
use antidrift_kernel::semantic_facts::SemanticFact;
use antidrift_kernel::span_index::LineIndex;
use antidrift_rules::create_rule;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tsrs_ast::SourceFile;
use tsrs_compiler::{ProgramOptions, new_compiler_host, new_program};
use tsrs_core::tspath;
use tsrs_core::{P, Tristate};
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::linter::{Options, lint_files};
use tsrslint::overlayfs::OverlayFS;
use tsrslint::rule::Rule;

use crate::tsgolint_host::inferred_compiler_options;

#[derive(Debug, Clone)]
pub(crate) struct RuleActivation {
    pub(crate) severity: Severity,
    pub(crate) options: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BatchCaseInput {
    pub(crate) id: String,
    pub(crate) filename: String,
    pub(crate) source_text: String,
    #[serde(default)]
    pub(crate) rule: Option<String>,
    #[serde(default)]
    pub(crate) options: Option<Value>,
    #[serde(default)]
    pub(crate) rules: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub(crate) settings: Option<Value>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) report_unused_directives: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchCaseOutput {
    pub(crate) id: String,
    pub(crate) diagnostics: Vec<RuleDiagnostic>,
    pub(crate) facts: Vec<SemanticFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fixed_text: Option<String>,
}

pub(crate) fn run_batch_json(source_spec: &str) -> Result<String, String> {
    tsrs_checker::links::set_sparse_id_pages(true);
    let raw = if source_spec == "-" {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .map_err(|err| format!("failed to read stdin: {err}"))?;
        buf
    } else {
        fs::read_to_string(source_spec)
            .map_err(|err| format!("failed to read {source_spec}: {err}"))?
    };

    let cases: Vec<BatchCaseInput> =
        serde_json::from_str(&raw).map_err(|err| format!("failed to parse batch JSON: {err}"))?;

    let outputs: Vec<BatchCaseOutput> = cases
        .par_iter()
        .map(evaluate_single_case)
        .collect::<Result<Vec<_>, String>>()?;

    serde_json::to_string(&outputs)
        .map_err(|err| format!("failed to serialize batch output: {err}"))
}

fn evaluate_single_case(case: &BatchCaseInput) -> Result<BatchCaseOutput, String> {
    let _ = &case.settings;
    let rule_set = build_case_rules(case)?;
    let normalized_file = tspath::normalize_slashes(&case.filename);
    let dir = case
        .cwd
        .as_deref()
        .map(tspath::normalize_slashes)
        .unwrap_or_else(|| tspath::get_directory_path(&normalized_file));
    let diagnostics = lint_source_file(
        &normalized_file,
        &case.source_text,
        &dir,
        &rule_set.rules,
        &rule_set.severities,
        case.report_unused_directives,
    );
    let fixed_text = apply_fixes(&case.source_text, &diagnostics);
    Ok(BatchCaseOutput {
        id: case.id.clone(),
        diagnostics,
        facts: Vec::new(),
        fixed_text,
    })
}

pub(crate) fn lint_source_file(
    normalized_file: &str,
    source_text: &str,
    dir: &str,
    active_rules: &[&'static dyn Rule],
    severities: &FxHashMap<String, Severity>,
    report_unused_directives: bool,
) -> Vec<RuleDiagnostic> {
    let line_index = LineIndex::new(source_text);
    let mut directives = DirectiveSet::from_source(source_text, &line_index);
    if active_rules.is_empty() {
        return directives.filter_diagnostics(
            Vec::new(),
            report_unused_directives,
            source_text,
            &line_index,
        );
    }
    let mut overrides = FxHashMap::default();
    overrides.insert(normalized_file.to_string(), source_text.to_string());
    let os_fs: Arc<dyn FS> = Arc::new(osvfs::fs());
    let overlay: Arc<dyn FS> = Arc::new(OverlayFS::new(os_fs, overrides));
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(cachedvfs::from(overlay)));
    let compiler_host =
        new_compiler_host(dir, Arc::clone(&fs), &bundled::lib_path(), None, None, None);
    let use_case = fs.use_case_sensitive_file_names();
    let mut copts = inferred_compiler_options();
    copts.no_lib = Tristate::True;
    let config = P::new(tsrs_tsoptions::new_parsed_command_line(
        P::new(copts),
        vec![normalized_file.to_string()],
        Vec::new(),
        tspath::ComparePathsOptions {
            use_case_sensitive_file_names: use_case,
            current_directory: dir.to_string(),
        },
    ));
    let mut popts = ProgramOptions::new(config, compiler_host);
    popts.single_threaded = Tristate::True;
    let program = new_program(popts);
    program.bind_source_files();
    let target_path = tspath::to_path(normalized_file, dir, use_case);
    let source_files: Vec<P<SourceFile>> = program
        .source_files()
        .iter()
        .copied()
        .filter(|sf| sf.path() == &target_path)
        .collect();
    let mut raw_diagnostics = Vec::new();
    for item in lint_files(program, &source_files, active_rules, &Options::default()) {
        let start = effective_token_start(source_text, item.pos, item.end);
        let end = u32::try_from(item.end.max(0)).unwrap_or(start);
        let severity = severities
            .get(item.rule_name)
            .copied()
            .unwrap_or(Severity::Error);
        let fix = item
            .fixes
            .as_ref()
            .filter(|fixes| !fixes.is_empty())
            .map(|fixes| RuleFix {
                edits: fixes
                    .iter()
                    .map(|f| TextEdit {
                        start: u32::try_from(f.pos.max(0)).unwrap_or(0),
                        end: u32::try_from(f.end.max(0)).unwrap_or(0),
                        text: f.text.clone(),
                    })
                    .collect(),
            });
        raw_diagnostics.push(RuleDiagnostic {
            rule_id: item.rule_name.to_string(),
            message_id: Some(item.message.id.to_string()),
            message: item.message.description.clone(),
            severity,
            location: line_index.diagnostic_location(source_text, start, end),
            fix,
        });
    }
    directives.filter_diagnostics(
        raw_diagnostics,
        report_unused_directives,
        source_text,
        &line_index,
    )
}

struct CaseRuleSet {
    rules: Vec<&'static dyn Rule>,
    severities: FxHashMap<String, Severity>,
}

fn build_case_rules(case: &BatchCaseInput) -> Result<CaseRuleSet, String> {
    let mut rules: Vec<&'static dyn Rule> = Vec::new();
    let mut severities: FxHashMap<String, Severity> = FxHashMap::default();
    if let Some(rule_name) = &case.rule {
        let options = match &case.options {
            Some(Value::Array(arr)) => Some(Value::Array(arr.clone())),
            Some(Value::Null) | None => None,
            Some(single) => Some(Value::Array(vec![single.clone()])),
        };
        let Some(rule) = create_rule(rule_name, options.as_ref())
            .map_err(|err| format!("{}: {err}", case.filename))?
        else {
            return Err(format!(
                "unknown rule '{rule_name}' in batch case '{}'",
                case.id
            ));
        };
        let leaked: &'static dyn Rule = Box::leak(rule);
        severities.insert(leaked.name().to_string(), Severity::Error);
        rules.push(leaked);
    }
    if let Some(rules_map) = &case.rules {
        for (rule_id, config) in rules_map {
            let act = parse_rule_config_entry(rule_id, config)?;
            let Some(rule) = create_rule(rule_id, Some(&act.options))
                .map_err(|err| format!("{}: {err}", case.filename))?
            else {
                return Err(format!(
                    "unknown rule '{rule_id}' in batch case '{}'",
                    case.id
                ));
            };
            if act.severity != Severity::Off {
                let leaked: &'static dyn Rule = Box::leak(rule);
                severities.insert(leaked.name().to_string(), act.severity);
                rules.push(leaked);
            }
        }
    }
    Ok(CaseRuleSet { rules, severities })
}

pub(crate) fn parse_rule_config_entry(
    rule_id: &str,
    config: &Value,
) -> Result<RuleActivation, String> {
    match config {
        Value::String(level) => Ok(RuleActivation {
            severity: parse_severity_level(rule_id, level)?,
            options: Value::Array(Vec::new()),
        }),
        Value::Number(num) => {
            let severity = match num.as_u64() {
                Some(0) => Severity::Off,
                Some(1) => Severity::Warn,
                Some(2) => Severity::Error,
                _ => {
                    return Err(format!(
                        "invalid numeric severity {num} for rule '{rule_id}': expected 0, 1, or 2"
                    ));
                }
            };
            Ok(RuleActivation {
                severity,
                options: Value::Array(Vec::new()),
            })
        }
        Value::Array(items) => {
            let Some(first) = items.first() else {
                return Err(format!(
                    "invalid empty array config for rule '{rule_id}': expected [severity, ...options]"
                ));
            };
            let base = parse_rule_config_entry(rule_id, first)?;
            let tail: Vec<Value> = items.iter().skip(1).cloned().collect();
            Ok(RuleActivation {
                severity: base.severity,
                options: Value::Array(tail),
            })
        }
        other => Err(format!(
            "invalid config entry {other} for rule '{rule_id}': expected string, number, or array"
        )),
    }
}

fn parse_severity_level(rule_id: &str, level: &str) -> Result<Severity, String> {
    match level {
        "off" | "0" => Ok(Severity::Off),
        "warn" | "warning" | "1" => Ok(Severity::Warn),
        "error" | "2" => Ok(Severity::Error),
        other => Err(format!(
            "invalid severity '{other}' for rule '{rule_id}': expected off, warn, or error"
        )),
    }
}
