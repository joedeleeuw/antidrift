mod batch;
mod cli;
mod format;
mod runner;
mod tsgolint_host;
mod tsgolint_runner;

use antidrift_rules::all_rules;
use antidrift_rules::tsrslint_rules::default_typed_rules;
use batch::run_batch_json;
use cli::parse_cli_args;
use runner::run_workspace;
use rustc_hash::FxHashSet;
use std::process::ExitCode;

fn run_headless_thread(rest: Vec<String>) -> ExitCode {
    let spawned = std::thread::Builder::new()
        .stack_size(512 << 20)
        .spawn(move || tsgolint_runner::run_headless(&rest));
    match spawned {
        Ok(handle) => match handle.join() {
            Ok(0) => ExitCode::SUCCESS,
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(_) => ExitCode::from(1),
        },
        Err(_) => ExitCode::from(1),
    }
}

fn main() -> ExitCode {
    let raw_vec: Vec<String> = std::env::args().skip(1).collect();
    if raw_vec.first().map(String::as_str) == Some("headless") {
        return run_headless_thread(raw_vec[1..].to_vec());
    }
    if matches!(
        raw_vec.first().map(String::as_str),
        Some("--version" | "version")
    ) {
        println!(
            "antidrift-linter {} (tsgolint headless protocol v2)",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }

    let args = match parse_cli_args(raw_vec) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            return ExitCode::from(2);
        }
    };

    if args.list_rules {
        let mut seen = FxHashSet::default();
        for rule in all_rules() {
            if seen.insert(rule.id().to_string()) {
                println!("{}", rule.id());
            }
        }
        for typed_rule in default_typed_rules() {
            if seen.insert(typed_rule.name().to_string()) {
                println!("{}", typed_rule.name());
            }
        }
        return ExitCode::SUCCESS;
    }

    if let Some(batch_spec) = &args.batch_json {
        match run_batch_json(batch_spec) {
            Ok(json_output) => {
                println!("{json_output}");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                eprintln!("antidrift-linter: {err}");
                return ExitCode::from(2);
            }
        }
    }

    match run_workspace(&args) {
        Ok(0) => ExitCode::SUCCESS,
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            ExitCode::from(2)
        }
    }
}
