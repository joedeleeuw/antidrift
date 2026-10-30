use std::collections::BTreeMap;

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
use tsrslint::protocol::{Diagnostic, Payload};
use tsrslint::rule::{ReportedDiagnostic, Rule};
use tsrslint::rules;

fn has_non_empty_options(options: Option<&serde_json::Value>) -> bool {
    match options {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Array(items)) => {
            items.first().is_some_and(|first| !first.is_null())
        }
        Some(_) => true,
    }
}

fn instantiate_rule(
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

pub(crate) struct ConfigRulePlan {
    rules_by_config: Vec<Vec<&'static dyn Rule>>,
    file_to_config: FxHashMap<String, usize>,
    inject_defaults: bool,
}

pub(crate) fn push_unique_rule(
    config_rules: &mut Vec<&'static dyn Rule>,
    candidate: &'static dyn Rule,
) {
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

fn resolve_cached_rule(
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

pub(crate) fn build_config_rule_plan(
    payload: &Payload,
    cwd: &str,
    inject_defaults: bool,
) -> Result<ConfigRulePlan, String> {
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

pub(crate) fn lint_program_files(
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
