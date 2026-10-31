mod async_effects;
mod boundary_decode;
mod cargo_manifest;
mod catalog;
mod config;
mod config_owner;
mod constant_fields;
mod corpus_smells;
mod discard_shapes;
mod expression_shapes;
mod lifecycle_names;
mod module_graph;
mod rules;
mod smells;
mod source_context;
mod struct_index;
mod struct_shapes;
mod syn_kernel;
mod syntax;
mod type_aliases;
mod value_flow;
mod value_origin;
mod workspace;
mod wrapping;

use antidrift_kernel::diagnostic::Severity;
use config_owner::{ConfigResolver, absolute_path};
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
}

struct RustArgs {
    json_output: bool,
    deny_warnings: bool,
    list_rules: bool,
    roots: Vec<String>,
}

fn parse_rust_args(raw_args: &[String]) -> Result<Option<RustArgs>, String> {
    let mut args = RustArgs {
        json_output: false,
        deny_warnings: false,
        list_rules: false,
        roots: Vec::new(),
    };
    let mut iter = raw_args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--help" || arg == "-h" {
            println!(
                "Usage: antidrift-linter rust [--json] [--format human|stylish|json] [--deny-warnings] [--list-rules] [paths...]"
            );
            return Ok(None);
        } else if arg == "--json" {
            args.json_output = true;
        } else if arg == "--list-rules" {
            args.list_rules = true;
        } else if arg == "--deny-warnings" {
            args.deny_warnings = true;
        } else if arg == "--format" {
            let fmt = iter.next().ok_or("missing value for --format")?;
            match fmt.as_str() {
                "json" => args.json_output = true,
                "human" | "stylish" => args.json_output = false,
                other => {
                    return Err(format!(
                        "unsupported format '{other}' for `rust` (expected human, stylish, or json)"
                    ));
                }
            }
        } else if let Some(flag) = arg.strip_prefix('-') {
            return Err(format!("unknown `rust` flag: -{flag}"));
        } else {
            args.roots.push(arg.clone());
        }
    }
    if args.roots.is_empty() {
        args.roots.push(".".to_owned());
    }
    Ok(Some(args))
}

pub(crate) fn run_rust_cli(raw_args: &[String]) -> Result<i32, String> {
    let Some(RustArgs {
        json_output,
        deny_warnings,
        list_rules,
        roots,
    }) = parse_rust_args(raw_args)?
    else {
        return Ok(0);
    };
    if list_rules {
        return print_resolved_rules(&roots, json_output);
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

fn print_resolved_rules(roots: &[String], json_output: bool) -> Result<i32, String> {
    let [root] = roots else {
        return Err("--list-rules resolves one workspace; pass exactly one path".to_owned());
    };
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!(
            "--list-rules needs a workspace directory, got {root}"
        ));
    }
    let resolved = ConfigResolver::default()
        .config_for_directory(&absolute_path(root_path)?)?
        .resolved_rules();
    if json_output {
        let rendered = serde_json::to_string_pretty(&resolved)
            .map_err(|err| format!("failed to serialize rust rules: {err}"))?;
        println!("{rendered}");
        return Ok(0);
    }
    for rule in &resolved {
        let level = match rule.level {
            Severity::Error => "error",
            Severity::Warn => "warn",
            Severity::Off => "off",
        };
        println!("{} {level}", rule.id);
    }
    Ok(0)
}
