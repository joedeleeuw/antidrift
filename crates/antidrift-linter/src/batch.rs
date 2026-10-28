use antidrift_kernel::diagnostic::{RuleDiagnostic, Severity, apply_fixes};
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_kernel::rule::{LintFileRequest, RuleActivation, lint_file};
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::semantic_facts::SemanticFact;
use antidrift_kernel::ts_resolver::TsDeclarationResolver;
use antidrift_rules::all_rules;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

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
    let rules = all_rules();
    let default_registries = PolicyRegistries::load_from_repo(Path::new("."))?;

    let outputs: Vec<BatchCaseOutput> = cases
        .par_iter()
        .map(|case| evaluate_single_case(case, &rules, &default_registries))
        .collect::<Result<Vec<_>, String>>()?;

    serde_json::to_string(&outputs)
        .map_err(|err| format!("failed to serialize batch output: {err}"))
}

fn evaluate_single_case(
    case: &BatchCaseInput,
    rules: &[Box<dyn antidrift_kernel::rule::Rule>],
    default_registries: &PolicyRegistries,
) -> Result<BatchCaseOutput, String> {
    let active_rules = build_case_activations(case, rules)?;
    let settings = case.settings.as_ref().unwrap_or(&Value::Null);
    let resolver = case.cwd.as_ref().map(|cwd| {
        let tsconfig = TsDeclarationResolver::discover_governing_tsconfig(Path::new(cwd));
        TsDeclarationResolver::new(tsconfig)
    });

    let request = LintFileRequest {
        file_path: &case.filename,
        source_text: &case.source_text,
        active_rules: &active_rules,
        settings,
        registries: default_registries,
        resolver: resolver.as_ref(),
        report_unused_directives: case.report_unused_directives,
    };
    let result = lint_file(&request, rules);
    let fixed_text = apply_fixes(&case.source_text, &result.diagnostics);
    Ok(BatchCaseOutput {
        id: case.id.clone(),
        diagnostics: result.diagnostics,
        facts: result.facts,
        fixed_text,
    })
}

fn is_known_batch_rule(rule_name: &str, rules: &[Box<dyn antidrift_kernel::rule::Rule>]) -> bool {
    rules.iter().any(|rule| {
        let short = rule.id().strip_prefix("antidrift/").unwrap_or(rule.id());
        rule.id() == rule_name || short == rule_name
    })
}

fn build_case_activations(
    case: &BatchCaseInput,
    rules: &[Box<dyn antidrift_kernel::rule::Rule>],
) -> Result<BTreeMap<String, RuleActivation>, String> {
    let mut activations = BTreeMap::new();
    if let Some(rule_name) = &case.rule {
        if !is_known_batch_rule(rule_name, rules) {
            return Err(format!(
                "unknown rule '{rule_name}' in batch case '{}'",
                case.id
            ));
        }
        let options = match &case.options {
            Some(Value::Array(arr)) => Value::Array(arr.clone()),
            Some(Value::Null) | None => Value::Array(Vec::new()),
            Some(single) => Value::Array(vec![single.clone()]),
        };
        RuleScope::from_options(rule_name, Some(&options))?;
        activations.insert(
            rule_name.clone(),
            RuleActivation {
                severity: Severity::Error,
                options,
            },
        );
    }
    if let Some(rules_map) = &case.rules {
        for (rule_id, config) in rules_map {
            if !is_known_batch_rule(rule_id, rules) {
                return Err(format!(
                    "unknown rule '{rule_id}' in batch case '{}'",
                    case.id
                ));
            }
            let act = parse_rule_config_entry(rule_id, config)?;
            RuleScope::from_options(rule_id, Some(&act.options))?;
            activations.insert(rule_id.clone(), act);
        }
    }
    Ok(activations)
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
