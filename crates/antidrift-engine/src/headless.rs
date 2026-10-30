use std::collections::BTreeMap;
use std::io::{Read, Write};

use antidrift_kernel::directives::is_inline_disabled;
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_rules::{create_rule, default_rules, is_typescript_only_rule, lookup_default_rule};
use rustc_hash::FxHashMap;
use serde_json::json;
use tsrs_ast::SourceFile;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrslint::linter::{Options, lint_files};
use tsrslint::protocol::{
    self, Diagnostic, MessageType, Payload, deserialize_payload, write_error_message, write_message,
};
use tsrslint::rule::{ReportedDiagnostic, Rule};
use tsrslint::rules;

use crate::headless_host::{
    ProgramBuilderEnv, base_fs, collect_missing_bound_files, filter_suppressed_diagnostics,
};

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

fn has_non_empty_options(options: Option<&serde_json::Value>) -> bool {
    match options {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Array(items)) => {
            items.first().is_some_and(|first| !first.is_null())
        }
        Some(_) => true,
    }
}

pub(crate) fn instantiate_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<&'static dyn Rule>, String> {
    if !has_non_empty_options(options)
        && let Some(default_rule) = lookup_default_rule(name)
    {
        return Ok(Some(default_rule));
    }
    if let Some(custom) = create_rule(name, options)? {
        return Ok(Some(Box::leak(custom)));
    }
    let created = rules::create_rule(name, options)?;
    Ok(Some(Box::leak(created)))
}

struct ConfigRulePlan {
    rules_by_config: Vec<Vec<&'static dyn Rule>>,
    file_to_config: FxHashMap<String, usize>,
    inject_defaults: bool,
}

fn push_unique_rule(config_rules: &mut Vec<&'static dyn Rule>, candidate: &'static dyn Rule) {
    if !config_rules
        .iter()
        .any(|existing| existing.name() == candidate.name())
    {
        config_rules.push(candidate);
    }
}

fn append_default_rules(
    config_rules: &mut Vec<&'static dyn Rule>,
    rule_cache: &mut FxHashMap<String, &'static dyn Rule>,
    registries: &PolicyRegistries,
) -> Result<(), String> {
    if let Some(authz_calls) = registries.required_calls.get("authorization") {
        let opts = if registries.server_boundary_globs.is_empty() {
            json!([{ "authzFunctions": authz_calls }])
        } else {
            json!([{
                "authzFunctions": authz_calls,
                "files": registries.server_boundary_globs,
            }])
        };
        if let Some(rule) =
            resolve_cached_rule(rule_cache, "antidrift/require-authz-check", Some(&opts))?
        {
            push_unique_rule(config_rules, rule);
        }
    }
    if !registries.statuses.is_empty() {
        let opts = json!([{ "statuses": registries.statuses }]);
        if let Some(rule) = resolve_cached_rule(
            rule_cache,
            "antidrift/no-redeclared-owned-union",
            Some(&opts),
        )? {
            push_unique_rule(config_rules, rule);
        }
    }
    for custom_rule in default_rules() {
        push_unique_rule(config_rules, custom_rule);
    }
    Ok(())
}

pub(crate) fn default_workspace_rules(
    registries: &PolicyRegistries,
) -> Result<Vec<&'static dyn Rule>, String> {
    let mut config_rules = Vec::new();
    let mut rule_cache = FxHashMap::default();
    append_default_rules(&mut config_rules, &mut rule_cache, registries)?;
    Ok(config_rules)
}

pub(crate) fn resolve_cached_rule(
    rule_cache: &mut FxHashMap<String, &'static dyn Rule>,
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<&'static dyn Rule>, String> {
    let key = format!(
        "{name}\u{0}{}",
        options.map(ToString::to_string).unwrap_or_default()
    );
    if let Some(&cached) = rule_cache.get(&key) {
        return Ok(Some(cached));
    }
    let Some(created) = instantiate_rule(name, options)? else {
        return Ok(None);
    };
    rule_cache.insert(key, created);
    Ok(Some(created))
}

fn build_config_rule_plan(payload: &Payload, cwd: &str) -> Result<ConfigRulePlan, String> {
    let inject_defaults = std::env::var("ANTIDRIFT_TSGOLINT_DEFAULTS").is_ok_and(|val| val == "1")
        && !std::env::var("ANTIDRIFT_DISABLE_TYPED_RULES").is_ok_and(|val| val == "1");
    let registries = if inject_defaults {
        PolicyRegistries::load_from_repo(std::path::Path::new(cwd))?
    } else {
        PolicyRegistries::default()
    };
    let mut rule_cache: FxHashMap<String, &'static dyn Rule> = FxHashMap::default();
    let mut rules_by_config: Vec<Vec<&'static dyn Rule>> =
        Vec::with_capacity(payload.configs.len());
    let mut file_to_config: FxHashMap<String, usize> = FxHashMap::default();
    for (config_idx, config) in payload.configs.iter().enumerate() {
        let mut config_rules: Vec<&'static dyn Rule> = Vec::new();
        for rule_spec in &config.rules {
            if let Some(leaked) =
                resolve_cached_rule(&mut rule_cache, &rule_spec.name, rule_spec.options.as_ref())?
            {
                push_unique_rule(&mut config_rules, leaked);
            }
        }
        if inject_defaults {
            append_default_rules(&mut config_rules, &mut rule_cache, &registries)?;
        }
        for file_path in &config.file_paths {
            file_to_config.insert(tspath::normalize_slashes(file_path), config_idx);
        }
        rules_by_config.push(config_rules);
    }
    Ok(ConfigRulePlan {
        rules_by_config,
        file_to_config,
        inject_defaults,
    })
}

fn to_protocol_diagnostic(reported: &ReportedDiagnostic) -> Diagnostic {
    let mut proto = reported.to_protocol();
    if reported.rule_name.starts_with("antidrift/") {
        proto.kind = 1;
        proto.rule = None;
        reported.rule_name.clone_into(&mut proto.message.id);
    }
    proto
}

fn lint_program_files(
    program: &'static Program,
    source_files: &[P<SourceFile>],
    plan: &ConfigRulePlan,
    opts: &Options,
    out_diags: &mut Vec<Diagnostic>,
) {
    let mut groups: BTreeMap<(usize, u8), Vec<P<SourceFile>>> = BTreeMap::new();
    for &sf in source_files {
        let name = sf.file_name();
        let normalized = tspath::normalize_slashes(name);
        let Some(&config_idx) = plan.file_to_config.get(&normalized) else {
            continue;
        };
        let bucket = u8::from(plan.inject_defaults && tspath::has_js_file_extension(name));
        groups.entry((config_idx, bucket)).or_default().push(sf);
    }
    for ((config_idx, bucket), files) in groups {
        let Some(base_rules) = plan.rules_by_config.get(config_idx) else {
            continue;
        };
        let active_rules: Vec<&'static dyn Rule> = if bucket == 1 {
            base_rules
                .iter()
                .copied()
                .filter(|rule| !is_typescript_only_rule(rule.name()))
                .collect()
        } else {
            base_rules.clone()
        };
        if active_rules.is_empty() {
            continue;
        }
        for item in &lint_files(program, &files, &active_rules, opts) {
            if item.rule_name.starts_with("antidrift/")
                && is_inline_disabled(item.file.text(), item.pos, item.end, item.rule_name)
            {
                continue;
            }
            out_diags.push(to_protocol_diagnostic(item));
        }
    }
}

pub(crate) fn execute_payload(
    payload: &Payload,
    cwd: &str,
    opts: &Options,
) -> Result<Vec<Diagnostic>, String> {
    tsrs_checker::links::set_sparse_id_pages(true);
    let env = ProgramBuilderEnv::new(base_fs(payload), cwd);
    let plan = build_config_rule_plan(payload, cwd)?;
    let mut requested_files: Vec<String> = Vec::new();
    for config in &payload.configs {
        for file_path in &config.file_paths {
            requested_files.push(tspath::normalize_slashes(file_path));
        }
    }
    let (programs, mut unmatched) = env.group_files_by_tsconfig(&requested_files);
    let suppress_program_diagnostics =
        std::env::var("OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS")
            .is_ok_and(|val| val == "true");
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    for (config_file_name, config_files) in &programs {
        match env.run_configured_program(
            config_file_name,
            config_files,
            suppress_program_diagnostics,
        ) {
            Ok(bound) => {
                collect_missing_bound_files(&bound.source_files, config_files, &mut unmatched);
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
    if !unmatched.is_empty() {
        let bound = env.build_inferred_program(&unmatched);
        lint_program_files(
            bound.program,
            &bound.source_files,
            &plan,
            opts,
            &mut diagnostics,
        );
    }
    filter_suppressed_diagnostics(cwd, diagnostics)
}

pub(crate) fn run_headless(args: &[String]) -> i32 {
    let opts = match parse_headless_flags(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            write_error_message(&format!("error parsing options: {err}"));
            return 1;
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(dir) => tspath::normalize_path(&dir.to_string_lossy()),
        Err(err) => {
            write_error_message(&format!("error getting current directory: {err}"));
            return 1;
        }
    };
    let mut input_bytes = Vec::new();
    if let Err(err) = std::io::stdin().read_to_end(&mut input_bytes) {
        write_error_message(&format!("error reading from stdin: {err}"));
        return 1;
    }
    let payload = match deserialize_payload(&input_bytes) {
        Ok(parsed) => parsed,
        Err(err) => {
            write_error_message(&format!("error parsing config: {err}"));
            return 1;
        }
    };
    match execute_payload(&payload, &cwd, &opts) {
        Ok(diagnostics) => {
            let mut writer = std::io::BufWriter::with_capacity(4096 * 64, std::io::stdout());
            for diag in &diagnostics {
                if let Err(err) = write_message(&mut writer, MessageType::Diagnostic, diag) {
                    write_error_message(&format!("error writing diagnostic: {err}"));
                    return 1;
                }
            }
            if opts.debug_timings {
                let empty_timings = protocol::TimingPayload { rules: Vec::new() };
                if let Err(err) = write_message(&mut writer, MessageType::Timing, &empty_timings) {
                    write_error_message(&format!("error writing timings: {err}"));
                    return 1;
                }
            }
            if let Err(err) = writer.flush() {
                write_error_message(&format!("error flushing output: {err}"));
                return 1;
            }
            0
        }
        Err(err) => {
            write_error_message(&format!("error running linter: {err}"));
            1
        }
    }
}
