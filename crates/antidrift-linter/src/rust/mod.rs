mod async_effects;
mod boundary_decode;
mod cargo_manifest;
mod constant_fields;
mod corpus_smells;
mod expression_shapes;
mod module_graph;
mod rules;
mod smells;
mod struct_index;
mod struct_shapes;
mod syn_kernel;
mod syntax;
mod value_flow;
mod value_origin;
mod workspace;

use antidrift_kernel::diagnostic::Severity;
use serde::Serialize;
use std::path::Path;
use workspace::check_workspace_root;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RustDiagnostic {
    pub(crate) file: String,
    pub(crate) line: usize,
    pub(crate) rule_id: &'static str,
    pub(crate) severity: Severity,
    pub(crate) message: String,
}

impl RustDiagnostic {
    pub(super) fn error(file: String, line: usize, rule_id: &'static str, message: String) -> Self {
        Self {
            file,
            line,
            rule_id,
            severity: Severity::Error,
            message,
        }
    }

    pub(super) fn warn(file: String, line: usize, rule_id: &'static str, message: String) -> Self {
        Self {
            file,
            line,
            rule_id,
            severity: Severity::Warn,
            message,
        }
    }
}

pub(crate) fn run_rust_cli(raw_args: &[String]) -> Result<i32, String> {
    let mut json_output = false;
    let mut deny_warnings = false;
    let mut roots = Vec::new();
    let mut iter = raw_args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--help" || arg == "-h" {
            println!(
                "Usage: antidrift-linter rust [--json] [--format human|stylish|json] [--deny-warnings] [paths...]"
            );
            return Ok(0);
        } else if arg == "--json" {
            json_output = true;
        } else if arg == "--deny-warnings" {
            deny_warnings = true;
        } else if arg == "--format" {
            let fmt = iter.next().ok_or("missing value for --format")?;
            match fmt.as_str() {
                "json" => json_output = true,
                "human" | "stylish" => json_output = false,
                other => {
                    return Err(format!(
                        "unsupported format '{other}' for `rust` (expected human, stylish, or json)"
                    ));
                }
            }
        } else if let Some(flag) = arg.strip_prefix('-') {
            return Err(format!("unknown `rust` flag: -{flag}"));
        } else {
            roots.push(arg.clone());
        }
    }
    if roots.is_empty() {
        roots.push(".".to_owned());
    }

    let mut diagnostics = Vec::new();
    let mut total_files = 0usize;
    for root_str in &roots {
        let root_path = Path::new(root_str);
        if !root_path.exists() {
            return Err(format!("path does not exist: {root_str}"));
        }
        total_files += check_workspace_root(root_path, &mut diagnostics)?;
    }

    diagnostics.sort();
    diagnostics.dedup();
    let has_failing_diagnostics = diagnostics.iter().any(|diag| {
        diag.severity == Severity::Error || (deny_warnings && diag.severity == Severity::Warn)
    });

    if json_output {
        let rendered = serde_json::to_string_pretty(&diagnostics)
            .map_err(|err| format!("failed to serialize rust diagnostics: {err}"))?;
        println!("{rendered}");
        return Ok(i32::from(has_failing_diagnostics));
    }

    if diagnostics.is_empty() {
        println!("Rust checks passed ({total_files} files checked)");
        return Ok(0);
    }

    for diag in &diagnostics {
        let level = match diag.severity {
            Severity::Error => "error",
            Severity::Warn => "warning",
            Severity::Off => continue,
        };
        eprintln!(
            "{}:{} {level} [{}]: {}",
            diag.file, diag.line, diag.rule_id, diag.message
        );
    }
    if !has_failing_diagnostics {
        println!(
            "Rust checks passed with {} warning(s) ({total_files} files checked)",
            diagnostics.len()
        );
        return Ok(0);
    }
    Ok(1)
}
