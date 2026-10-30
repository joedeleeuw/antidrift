#![forbid(unsafe_code)]

mod batch;
mod cli;
mod derive;
mod format;
mod headless;
mod headless_host;
mod runner;
mod rust;
pub mod session;

use antidrift_rules::all_rules;
use batch::run_batch_json;
use cli::{CliAction, parse_cli_args};
use derive::run_derive;
use runner::run_workspace;
use rust::run_rust_cli;
use rustc_hash::FxHashSet;
use std::process::ExitCode;

fn run_headless_thread(rest: Vec<String>) -> ExitCode {
    let spawned = std::thread::Builder::new()
        .stack_size(512 << 20)
        .spawn(move || headless::run_headless(&rest));
    match spawned {
        Ok(handle) => match handle.join() {
            Ok(0) => ExitCode::SUCCESS,
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(panic_payload) => {
                eprintln!("antidrift-linter headless thread panicked: {panic_payload:?}");
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("antidrift-linter: failed to spawn headless thread: {err}");
            ExitCode::from(1)
        }
    }
}

fn run_batch_thread(spec: String) -> ExitCode {
    let spawned = std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(move || run_batch_json(&spec));
    match spawned {
        Ok(handle) => match handle.join() {
            Ok(Ok(json_output)) => {
                println!("{json_output}");
                ExitCode::SUCCESS
            }
            Ok(Err(err)) => {
                eprintln!("antidrift-linter: {err}");
                ExitCode::from(2)
            }
            Err(panic_payload) => {
                eprintln!("antidrift-linter batch thread panicked: {panic_payload:?}");
                ExitCode::from(2)
            }
        },
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            ExitCode::from(2)
        }
    }
}

fn run_derive_thread(rest: Vec<String>) -> ExitCode {
    let spawned = std::thread::Builder::new()
        .stack_size(512 << 20)
        .spawn(move || run_derive(&rest));
    match spawned {
        Ok(handle) => match handle.join() {
            Ok(Ok(0)) => ExitCode::SUCCESS,
            Ok(Ok(code)) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Ok(Err(err)) => {
                eprintln!("antidrift-linter derive: {err}");
                ExitCode::from(2)
            }
            Err(panic_payload) => {
                eprintln!("antidrift-linter derive thread panicked: {panic_payload:?}");
                ExitCode::from(2)
            }
        },
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            ExitCode::from(2)
        }
    }
}

#[must_use]
pub fn run_cli() -> ExitCode {
    let raw_vec: Vec<String> = std::env::args().skip(1).collect();
    if raw_vec.first().map(String::as_str) == Some("headless") {
        return run_headless_thread(raw_vec[1..].to_vec());
    }
    if raw_vec.first().map(String::as_str) == Some("derive") {
        return run_derive_thread(raw_vec[1..].to_vec());
    }
    if raw_vec.first().map(String::as_str) == Some("rust") {
        return match run_rust_cli(&raw_vec[1..]) {
            Ok(0) => ExitCode::SUCCESS,
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(err) => {
                eprintln!("antidrift-linter rust: {err}");
                ExitCode::from(2)
            }
        };
    }
    if raw_vec.iter().any(|arg| {
        matches!(arg.as_str(), "--version" | "-V") || (raw_vec.len() == 1 && arg == "version")
    }) {
        println!(
            "antidrift-linter {} (tsgolint headless protocol v2)",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    if raw_vec
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h") || (raw_vec.len() == 1 && arg == "help"))
    {
        println!(
            "Usage:\n  antidrift-linter [--format human|stylish|json|sarif] [--json] [--fix] [--list-rules]\n                   [--batch-json <spec>] [--suppress-rule <id>] [--prune-suppressions]\n                   [--suppressions-location <path>] [--report-unused-disable-directives] [paths...]\n  antidrift-linter rust [--json] [--format human|stylish|json] [paths...]\n  antidrift-linter derive <package-root>\n  antidrift-linter headless"
        );
        return ExitCode::SUCCESS;
    }

    let action = match parse_cli_args(raw_vec) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            return ExitCode::from(2);
        }
    };

    match action {
        CliAction::ListRules => {
            let mut seen = FxHashSet::default();
            for rule in all_rules() {
                if seen.insert(rule.name().to_owned()) {
                    println!("{}", rule.name());
                }
            }
            ExitCode::SUCCESS
        }
        CliAction::BatchJson(batch_spec) => run_batch_thread(batch_spec),
        CliAction::Lint(args) => match run_workspace(&args) {
            Ok(0) => ExitCode::SUCCESS,
            Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            Err(err) => {
                eprintln!("antidrift-linter: {err}");
                ExitCode::from(2)
            }
        },
    }
}
