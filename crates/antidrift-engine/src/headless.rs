use std::env::VarError;
use std::io::{Read, Write};

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use tsrs_core::tspath;
use tsrslint::linter::Options;
use tsrslint::protocol::{
    self, Diagnostic, MessageType, Payload, deserialize_payload, write_error_message, write_message,
};

use crate::headless_host::{
    ProgramBuilderEnv, base_fs, collect_missing_bound_files, suppress_program_diagnostics_enabled,
};
use crate::relay;
use crate::rule_plan::{RulePlanCache, build_config_rule_plan, lint_program_files};

fn filter_suppressed_diagnostics(
    cwd: &str,
    diagnostics: Vec<Diagnostic>,
    seen_counts: &mut FxHashMap<(String, String), usize>,
) -> Result<Vec<Diagnostic>, String> {
    let path = std::path::Path::new(cwd).join("eslint-suppressions.json");
    let suppressions = antidrift_kernel::suppressions::SuppressionsTable::load(&path)?;
    Ok(diagnostics
        .into_iter()
        .filter(|diag| {
            let Some(fp) = &diag.file_path else {
                return true;
            };
            let rel = antidrift_kernel::provenance::relative_to_cwd(cwd, fp);
            let allowed = suppressions.suppressed_count(&rel, &diag.message.id);
            if allowed == 0 {
                return true;
            }
            let seen = seen_counts
                .entry((rel, diag.message.id.clone()))
                .and_modify(|count| *count += 1)
                .or_insert(1);
            *seen > allowed
        })
        .collect())
}

fn apply_debug_flag(raw: &str, opts: &mut Options) -> Result<(), String> {
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed == "timings" {
            opts.debug_timings = true;
        } else if !trimmed.is_empty() {
            return Err(format!("unknown debug option: {trimmed}"));
        }
    }
    Ok(())
}

fn parse_headless_flags(args: &[String]) -> Result<Options, String> {
    let mut opts = Options::default();
    let mut idx = 0;
    while idx < args.len() {
        let trimmed = args[idx].trim_start_matches('-');
        let (name, value) = match trimmed.split_once('=') {
            Some((key, val)) => (key, Some(val.to_owned())),
            None => (trimmed, None),
        };
        match name {
            "fix" => opts.fix = value.is_none_or(|val| val == "true"),
            "fix-suggestions" => opts.fix_suggestions = value.is_none_or(|val| val == "true"),
            "debug" => {
                let raw = match value {
                    Some(val) => val,
                    None => {
                        idx += 1;
                        args.get(idx)
                            .cloned()
                            .ok_or_else(|| "flag needs an argument: -debug".to_owned())?
                    }
                };
                apply_debug_flag(&raw, &mut opts)?;
            }
            "trace" | "cpuprof" | "heap" | "allocs" if value.is_none() => {
                idx += 1;
                if idx >= args.len() {
                    return Err(format!("flag needs an argument: -{name}"));
                }
            }
            "trace" | "cpuprof" | "heap" | "allocs" => {}
            other => return Err(format!("flag provided but not defined: -{other}")),
        }
        idx += 1;
    }
    Ok(opts)
}

fn requested_files(payload: &Payload) -> Vec<String> {
    payload
        .configs
        .iter()
        .flat_map(|config| &config.file_paths)
        .map(|file_path| tspath::normalize_slashes(file_path))
        .collect()
}

fn encode(diagnostics: &[Diagnostic]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for diag in diagnostics {
        write_message(&mut bytes, MessageType::Diagnostic, diag)
            .map_err(|err| format!("error writing diagnostic: {err}"))?;
    }
    Ok(bytes)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HeadlessRequest {
    pub(crate) cwd: String,
    args: Vec<String>,
    payload: String,
    suppress_program_diagnostics: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Leftovers {
    grouped: Vec<String>,
    inferred: Vec<String>,
    suppressed_seen: Vec<((String, String), usize)>,
}

pub(crate) enum RelayReply {
    Served {
        output: Vec<u8>,
        leftovers: Leftovers,
    },
    Failure(String),
}

impl HeadlessRequest {
    fn from_process(args: &[String]) -> Result<Self, String> {
        let cwd = std::env::current_dir()
            .map_err(|err| format!("error getting current directory: {err}"))?;
        let mut payload = String::new();
        std::io::stdin()
            .read_to_string(&mut payload)
            .map_err(|err| format!("error reading from stdin: {err}"))?;
        Ok(Self {
            cwd: tspath::normalize_path(&cwd.to_string_lossy()),
            args: args.to_vec(),
            payload,
            suppress_program_diagnostics: suppress_program_diagnostics_enabled(),
        })
    }

    fn parse(&self) -> Result<(Options, Payload), String> {
        let opts = parse_headless_flags(&self.args)
            .map_err(|err| format!("error parsing options: {err}"))?;
        let payload = deserialize_payload(self.payload.as_bytes())
            .map_err(|err| format!("error parsing config: {err}"))?;
        Ok((opts, payload))
    }

    pub(crate) fn serve_cached(
        &self,
        shared: Option<&ProgramBuilderEnv>,
        rule_plans: &mut RulePlanCache,
    ) -> RelayReply {
        match self.cached_output(shared, rule_plans) {
            Ok((output, leftovers)) => RelayReply::Served { output, leftovers },
            Err(message) => RelayReply::Failure(message),
        }
    }

    fn cached_output(
        &self,
        shared: Option<&ProgramBuilderEnv>,
        rule_plans: &mut RulePlanCache,
    ) -> Result<(Vec<u8>, Leftovers), String> {
        let (opts, payload) = self.parse()?;
        let files = requested_files(&payload);
        let Some(env) = shared.filter(|_| {
            payload
                .source_overrides
                .as_ref()
                .is_none_or(FxHashMap::is_empty)
        }) else {
            return Ok((
                Vec::new(),
                Leftovers {
                    grouped: files,
                    inferred: Vec::new(),
                    suppressed_seen: Vec::new(),
                },
            ));
        };
        tsrs_checker::links::set_sparse_id_pages(true);
        let plan = rule_plans
            .get(&payload)
            .map_err(|err| format!("error running linter: {err}"))?;
        let (programs, unmatched) = env.group_files_by_tsconfig(&files);
        let mut leftovers = Leftovers {
            grouped: Vec::new(),
            inferred: unmatched,
            suppressed_seen: Vec::new(),
        };
        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        for (config_file_name, config_files) in &programs {
            match env.current_program(
                config_file_name,
                config_files,
                self.suppress_program_diagnostics,
            ) {
                None => leftovers.grouped.extend(config_files.iter().cloned()),
                Some(Ok(bound)) => {
                    collect_missing_bound_files(
                        &bound.source_files,
                        config_files,
                        &mut leftovers.inferred,
                    );
                    lint_program_files(
                        bound.program,
                        &bound.source_files,
                        plan,
                        &opts,
                        &mut diagnostics,
                    );
                }
                Some(Err(config_diags)) => diagnostics.extend(config_diags),
            }
        }
        let mut seen_counts: FxHashMap<(String, String), usize> = FxHashMap::default();
        let diagnostics = filter_suppressed_diagnostics(&self.cwd, diagnostics, &mut seen_counts)
            .map_err(|err| format!("error running linter: {err}"))?;
        leftovers.suppressed_seen = seen_counts.into_iter().collect();
        Ok((encode(&diagnostics)?, leftovers))
    }

    fn finish(&self, served: Vec<u8>, leftovers: Option<Leftovers>) -> Result<Vec<u8>, String> {
        let (opts, payload) = self.parse()?;
        let leftovers = leftovers.unwrap_or_else(|| Leftovers {
            grouped: requested_files(&payload),
            inferred: Vec::new(),
            suppressed_seen: Vec::new(),
        });
        tsrs_checker::links::set_sparse_id_pages(true);
        let mut env = ProgramBuilderEnv::new(base_fs(payload.source_overrides.as_ref()), &self.cwd);
        let diagnostics = self
            .local_diagnostics(&mut env, &payload, &opts, leftovers)
            .map_err(|err| format!("error running linter: {err}"))?;
        let mut output = served;
        output.extend(encode(&diagnostics)?);
        if opts.debug_timings {
            let empty_timings = protocol::TimingPayload { rules: Vec::new() };
            write_message(&mut output, MessageType::Timing, &empty_timings)
                .map_err(|err| format!("error writing timings: {err}"))?;
        }
        Ok(output)
    }

    fn local_diagnostics(
        &self,
        env: &mut ProgramBuilderEnv,
        payload: &Payload,
        opts: &Options,
        leftovers: Leftovers,
    ) -> Result<Vec<Diagnostic>, String> {
        let mut seen_counts: FxHashMap<(String, String), usize> =
            leftovers.suppressed_seen.into_iter().collect();
        let plan = build_config_rule_plan(payload)?;
        let (programs, unmatched) = env.group_files_by_tsconfig(&leftovers.grouped);
        let mut inferred = leftovers.inferred;
        inferred.extend(unmatched);
        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        for (config_file_name, config_files) in &programs {
            match env.configured_program(
                config_file_name,
                config_files,
                self.suppress_program_diagnostics,
            ) {
                Ok(bound) => {
                    collect_missing_bound_files(&bound.source_files, config_files, &mut inferred);
                    lint_program_files(
                        bound.program,
                        &bound.source_files,
                        &plan,
                        opts,
                        &mut diagnostics,
                    );
                }
                Err(config_diags) => diagnostics.extend(config_diags),
            }
        }
        if !inferred.is_empty() {
            let bound = env.inferred_program(&inferred);
            lint_program_files(
                bound.program,
                &bound.source_files,
                &plan,
                opts,
                &mut diagnostics,
            );
        }
        filter_suppressed_diagnostics(&self.cwd, diagnostics, &mut seen_counts)
    }
}

fn route(args: &[String]) -> Result<Vec<u8>, String> {
    let request = HeadlessRequest::from_process(args)?;
    match std::env::var("ANTIDRIFT_ENGINE") {
        Ok(endpoint) => {
            let reply = relay::relay(&endpoint, &request).map_err(|err| {
                format!(
                    "the antidrift engine relay named by ANTIDRIFT_ENGINE ({endpoint}) failed: {err}"
                )
            })?;
            match reply {
                RelayReply::Served { output, leftovers } => request.finish(output, Some(leftovers)),
                RelayReply::Failure(message) => Err(message),
            }
        }
        Err(VarError::NotPresent) => request.finish(Vec::new(), None),
        Err(VarError::NotUnicode(raw)) => Err(format!(
            "ANTIDRIFT_ENGINE must name the antidrift engine relay as ADDRESS/TOKEN, got {}",
            raw.to_string_lossy()
        )),
    }
}

pub(crate) fn run_headless(args: &[String]) -> i32 {
    match route(args) {
        Ok(bytes) => {
            let written = std::io::stdout()
                .write_all(&bytes)
                .and_then(|()| std::io::stdout().flush());
            if let Err(err) = written {
                write_error_message(&format!("error flushing output: {err}"));
                return 1;
            }
            0
        }
        Err(message) => {
            write_error_message(&message);
            1
        }
    }
}
