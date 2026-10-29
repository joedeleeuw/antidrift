mod rules;
mod smells;
mod syntax;
mod workspace;

use serde::Serialize;
use std::path::Path;
use workspace::check_workspace_root;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RustDiagnostic {
    pub(crate) file: String,
    pub(crate) line: usize,
    pub(crate) rule_id: &'static str,
    pub(crate) message: String,
}

pub(crate) fn run_rust_cli(raw_args: &[String]) -> Result<i32, String> {
    let mut json_output = false;
    let mut roots = Vec::new();
    for arg in raw_args {
        if arg == "--help" || arg == "-h" {
            println!("Usage: antidrift-linter rust [--json] [paths...]");
            return Ok(0);
        } else if arg == "--json" {
            json_output = true;
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

    if json_output {
        let rendered = serde_json::to_string_pretty(&diagnostics)
            .map_err(|err| format!("failed to serialize rust diagnostics: {err}"))?;
        println!("{rendered}");
        return Ok(i32::from(!diagnostics.is_empty()));
    }

    if diagnostics.is_empty() {
        println!("Rust checks passed ({total_files} files checked)");
        return Ok(0);
    }

    for diag in &diagnostics {
        eprintln!(
            "{}:{} [{}]: {}",
            diag.file, diag.line, diag.rule_id, diag.message
        );
    }
    Ok(1)
}
