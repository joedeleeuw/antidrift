use antidrift_kernel::diagnostic::{RuleDiagnostic, Severity, apply_fixes};
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_kernel::rule::{EmitFactRequest, LintFileRequest, RuleActivation, lint_file};
use antidrift_kernel::semantic_facts::{SemanticFact, SemanticFactInput, build_semantic_fact};
use antidrift_kernel::span_index::LineIndex;
use antidrift_kernel::ts_resolver::TsDeclarationResolver;
use antidrift_rules::all_rules;
use oxc::span::Span;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchFactProbe {
    pub(crate) start: u32,
    pub(crate) end: u32,
    pub(crate) fact_kind: String,
    pub(crate) rule_id: String,
    pub(crate) adapter_id: String,
    pub(crate) confidence: String,
    pub(crate) provenance: Vec<String>,
    pub(crate) payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(default)]
    pub(crate) fact_probe: Option<BatchFactProbe>,
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
    let default_registries = PolicyRegistries::load_from_repo(Path::new(".")).unwrap_or_default();

    let outputs: Vec<BatchCaseOutput> = cases
        .par_iter()
        .map(|case| evaluate_single_case(case, &rules, &default_registries))
        .collect();

    serde_json::to_string(&outputs)
        .map_err(|err| format!("failed to serialize batch output: {err}"))
}

fn evaluate_single_case(
    case: &BatchCaseInput,
    rules: &[Box<dyn antidrift_kernel::rule::Rule>],
    default_registries: &PolicyRegistries,
) -> BatchCaseOutput {
    let active_rules = build_case_activations(case);
    let settings = case.settings.clone().unwrap_or(Value::Null);
    let resolver = case.cwd.as_ref().map(|cwd| {
        let tsconfig = TsDeclarationResolver::discover_governing_tsconfig(Path::new(cwd));
        TsDeclarationResolver::new(tsconfig)
    });

    let request = LintFileRequest {
        file_path: &case.filename,
        source_text: &case.source_text,
        active_rules: &active_rules,
        settings: &settings,
        registries: default_registries,
        resolver: resolver.as_ref(),
        report_unused_directives: case.report_unused_directives,
    };
    let mut result = lint_file(&request, rules);
    if let Some(probe) = &case.fact_probe {
        let line_index = LineIndex::new(&case.source_text);
        let req = EmitFactRequest {
            span: Span::new(probe.start, probe.end),
            fact_kind: probe.fact_kind.clone(),
            adapter_id: probe.adapter_id.clone(),
            confidence: probe.confidence.clone(),
            provenance: probe.provenance.clone(),
            payload: probe.payload.clone(),
        };
        let location = Some(line_index.fact_location(&case.source_text, req.span));
        result.facts.push(build_semantic_fact(SemanticFactInput {
            fact_kind: req.fact_kind,
            rule_id: probe.rule_id.clone(),
            adapter_id: req.adapter_id,
            confidence: req.confidence,
            provenance: req.provenance,
            file_path: case.filename.clone(),
            location,
            source_text: Some(case.source_text.clone()),
            payload: req.payload,
        }));
    }
    let fixed_text = apply_fixes(&case.source_text, &result.diagnostics);
    BatchCaseOutput {
        id: case.id.clone(),
        diagnostics: result.diagnostics,
        facts: result.facts,
        fixed_text,
    }
}

fn build_case_activations(case: &BatchCaseInput) -> BTreeMap<String, RuleActivation> {
    let mut activations = BTreeMap::new();
    if let Some(rule_name) = &case.rule {
        let options = match &case.options {
            Some(Value::Array(arr)) => Value::Array(arr.clone()),
            Some(Value::Null) | None => Value::Array(Vec::new()),
            Some(single) => Value::Array(vec![single.clone()]),
        };
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
            if let Some(act) = parse_rule_config_entry(config) {
                activations.insert(rule_id.clone(), act);
            }
        }
    }
    activations
}

#[must_use]
pub(crate) fn parse_rule_config_entry(config: &Value) -> Option<RuleActivation> {
    match config {
        Value::String(level) => Some(RuleActivation {
            severity: parse_severity_level(level)?,
            options: Value::Array(Vec::new()),
        }),
        Value::Number(num) => {
            let severity = match num.as_u64()? {
                0 => Severity::Off,
                1 => Severity::Warn,
                _ => Severity::Error,
            };
            Some(RuleActivation {
                severity,
                options: Value::Array(Vec::new()),
            })
        }
        Value::Array(items) => {
            let first = items.first()?;
            let base = parse_rule_config_entry(first)?;
            let tail: Vec<Value> = items.iter().skip(1).cloned().collect();
            Some(RuleActivation {
                severity: base.severity,
                options: Value::Array(tail),
            })
        }
        _ => None,
    }
}

fn parse_severity_level(level: &str) -> Option<Severity> {
    match level {
        "off" | "0" => Some(Severity::Off),
        "warn" | "warning" | "1" => Some(Severity::Warn),
        "error" | "2" => Some(Severity::Error),
        _ => None,
    }
}
