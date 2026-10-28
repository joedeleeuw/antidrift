mod batch;
mod cli;
mod format;
mod runner;
mod rust;
mod tsgolint_host;
mod tsgolint_runner;

use antidrift_rules::all_rules;
use batch::run_batch_json;
use cli::parse_cli_args;
use runner::run_workspace;
use rust::run_rust_cli;
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
            if seen.insert(rule.name().to_string()) {
                println!("{}", rule.name());
            }
        }
        return ExitCode::SUCCESS;
    }

    if let Some(batch_spec) = &args.batch_json {
        let spec = batch_spec.clone();
        let spawned = std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || run_batch_json(&spec));
        return match spawned {
            Ok(handle) => match handle.join() {
                Ok(Ok(json_output)) => {
                    println!("{json_output}");
                    ExitCode::SUCCESS
                }
                Ok(Err(err)) => {
                    eprintln!("antidrift-linter: {err}");
                    ExitCode::from(2)
                }
                Err(_) => ExitCode::from(2),
            },
            Err(err) => {
                eprintln!("antidrift-linter: {err}");
                ExitCode::from(2)
            }
        };
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
