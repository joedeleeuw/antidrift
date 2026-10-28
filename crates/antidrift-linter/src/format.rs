use crate::cli::OutputFormat;
use antidrift_kernel::diagnostic::{RuleDiagnostic, Severity};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;

pub(crate) fn format_diagnostics(
    format: OutputFormat,
    diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<String, String> {
    match format {
        OutputFormat::Human => format_human(diagnostics_by_file)
            .map_err(|err| format!("failed to format output: {err}")),
        OutputFormat::Json => format_eslint_json(diagnostics_by_file),
        OutputFormat::Sarif => format_sarif(diagnostics_by_file),
    }
}

fn format_human(
    diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<String, std::fmt::Error> {
    let mut out = String::new();
    let mut total_errors = 0_usize;
    let mut total_warnings = 0_usize;
    for (file_path, diags) in diagnostics_by_file {
        if diags.is_empty() {
            continue;
        }
        writeln!(out, "\n{file_path}")?;
        for diag in diags {
            let level = match diag.severity {
                Severity::Error => {
                    total_errors += 1;
                    "error"
                }
                Severity::Warn => {
                    total_warnings += 1;
                    "warning"
                }
                Severity::Off => continue,
            };
            writeln!(
                out,
                "  {}:{}  {level}  {}  {}",
                diag.location.line, diag.location.column, diag.message, diag.rule_id
            )?;
        }
    }
    let total = total_errors + total_warnings;
    if total > 0 {
        writeln!(
            out,
            "\n✖ {total} problems ({total_errors} errors, {total_warnings} warnings)"
        )?;
    }
    Ok(out)
}

fn format_eslint_json(
    diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<String, String> {
    let mut files: Vec<Value> = Vec::with_capacity(diagnostics_by_file.len());
    for (file_path, diags) in diagnostics_by_file {
        let mut error_count = 0_usize;
        let mut warning_count = 0_usize;
        let mut messages: Vec<Value> = Vec::with_capacity(diags.len());
        for diag in diags {
            match diag.severity {
                Severity::Error => error_count += 1,
                Severity::Warn => warning_count += 1,
                Severity::Off => continue,
            }
            messages.push(json!({
                "ruleId": diag.rule_id,
                "severity": diag.severity.eslint_code(),
                "message": diag.message,
                "messageId": diag.message_id,
                "line": diag.location.line,
                "column": diag.location.column,
                "endLine": diag.location.end_line,
                "endColumn": diag.location.end_column,
            }));
        }
        files.push(json!({
            "filePath": file_path,
            "messages": messages,
            "errorCount": error_count,
            "warningCount": warning_count,
        }));
    }
    serde_json::to_string_pretty(&files)
        .map_err(|err| format!("failed to serialize JSON output: {err}"))
}

fn format_sarif(
    diagnostics_by_file: &BTreeMap<String, Vec<RuleDiagnostic>>,
) -> Result<String, String> {
    let mut results: Vec<Value> = Vec::new();
    for (file_path, diags) in diagnostics_by_file {
        for diag in diags {
            let level = match diag.severity {
                Severity::Error => "error",
                Severity::Warn => "warning",
                Severity::Off => continue,
            };
            results.push(json!({
                "ruleId": diag.rule_id,
                "level": level,
                "message": { "text": diag.message },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": file_path },
                        "region": {
                            "startLine": diag.location.line,
                            "startColumn": diag.location.column,
                            "endLine": diag.location.end_line,
                            "endColumn": diag.location.end_column,
                        }
                    }
                }]
            }));
        }
    }
    let sarif = json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "antidrift-linter",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            },
            "results": results,
        }]
    });
    serde_json::to_string_pretty(&sarif)
        .map_err(|err| format!("failed to serialize SARIF output: {err}"))
}
