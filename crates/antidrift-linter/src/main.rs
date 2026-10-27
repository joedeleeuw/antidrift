mod batch;
mod cli;
mod format;
mod runner;

use antidrift_rules::all_rules;
use batch::run_batch_json;
use cli::parse_cli_args;
use runner::run_workspace;
use std::process::ExitCode;

fn main() -> ExitCode {
    let raw_args = std::env::args().skip(1);
    let args = match parse_cli_args(raw_args) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("antidrift-linter: {err}");
            return ExitCode::from(2);
        }
    };

    if args.list_rules {
        for rule in all_rules() {
            println!("{}", rule.id());
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
