use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex, OnceLock};

use antidrift_kernel::directives::is_inline_disabled;
use antidrift_kernel::registries::PolicyRegistries;
use antidrift_rules::{RuleInstance, all_entries, lookup_entry};
use rustc_hash::FxHashMap;
use serde_json::json;
use tsrs_ast::SourceFile;
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_core::tspath;
use tsrslint::linter::{Options, lint_files};
use tsrslint::protocol::{Diagnostic, Payload};
use tsrslint::rule::Rule;
use tsrslint::rules;

use crate::rule_scope::{RuleScope, Scoped, split_scope_envelope};

struct ScopedCatalogRule {
    default_enabled: bool,
    scoped: Scoped,
}

static SCOPED_CATALOG: LazyLock<Vec<ScopedCatalogRule>> = LazyLock::new(|| {
    all_entries()
        .into_iter()
        .map(|entry| ScopedCatalogRule {
            default_enabled: entry.default_enabled,
            scoped: Scoped::new(
                RuleScope::DEFAULT,
                entry.scope_policy,
                RuleInstance::Static(entry.rule),
            ),
        })
        .collect()
});

static CONFIGURED_RULE_SLOTS: [OnceLock<Box<dyn Rule>>; 512] = [const { OnceLock::new() }; 512];
static CONFIGURED_RULES: LazyLock<Mutex<FxHashMap<String, &'static dyn Rule>>> =
    LazyLock::new(Mutex::default);

fn default_scoped_rules() -> impl Iterator<Item = &'static dyn Rule> {
    SCOPED_CATALOG
        .iter()
        .filter(|entry| entry.default_enabled)
        .map(|entry| &entry.scoped as &'static dyn Rule)
}

pub(crate) fn all_scoped_rules() -> impl Iterator<Item = &'static dyn Rule> {
    SCOPED_CATALOG
        .iter()
        .map(|entry| &entry.scoped as &'static dyn Rule)
}

fn intern_configured_rule(
    key: String,
    build: impl FnOnce() -> Result<Box<dyn Rule>, String>,
) -> Result<&'static dyn Rule, String> {
    if let Some(&cached) = CONFIGURED_RULES
        .lock()
        .map_err(|err| format!("configured rule cache lock poisoned: {err}"))?
        .get(&key)
    {
        return Ok(cached);
    }
    let constructed = build()?;
    let mut guard = CONFIGURED_RULES
        .lock()
        .map_err(|err| format!("configured rule cache lock poisoned: {err}"))?;
    if let Some(&cached) = guard.get(&key) {
        return Ok(cached);
    }
    let slot = CONFIGURED_RULE_SLOTS
        .get(guard.len())
        .ok_or_else(|| "configured rule cache capacity exceeded".to_owned())?;
    let stored: &'static dyn Rule = &**slot.get_or_init(|| constructed);
    guard.insert(key, stored);
    Ok(stored)
}

pub(crate) fn instantiate_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<&'static dyn Rule>, String> {
    let Some(entry) = lookup_entry(name) else {
        let key = format!(
            "{name}\u{0}{}",
            options.map(ToString::to_string).unwrap_or_default()
        );
        return intern_configured_rule(key, || rules::create_rule(name, options)).map(Some);
    };
    let rule_name = entry.rule.name();
    let split = split_scope_envelope(rule_name, options)?;
    if split.scope.is_unscoped() && split.rule_options.is_none() {
        return Ok(SCOPED_CATALOG
            .iter()
            .find(|candidate| candidate.scoped.name() == rule_name)
            .map(|candidate| &candidate.scoped as &'static dyn Rule));
    }
    let key = format!(
        "{rule_name}\u{0}{}",
        options.map(ToString::to_string).unwrap_or_default()
    );
    intern_configured_rule(key, || {
        let scope = RuleScope::from_scope_options(rule_name, &split.scope)?;
        let rule = entry.instantiate(split.rule_options.as_ref())?;
        Ok(Box::new(Scoped::new(scope, entry.scope_policy, rule)))
    })
    .map(Some)
}

pub(crate) struct ConfigRulePlan {
    rules_by_config: Vec<Vec<&'static dyn Rule>>,
    file_to_config: FxHashMap<String, usize>,
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
    for custom_rule in default_scoped_rules() {
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

fn files_by_config(payload: &Payload) -> FxHashMap<String, usize> {
    payload
        .configs
        .iter()
        .enumerate()
        .flat_map(|(config_idx, config)| {
            config
                .file_paths
                .iter()
                .map(move |file_path| (tspath::normalize_slashes(file_path), config_idx))
        })
        .collect()
}

pub(crate) fn build_config_rule_plan(payload: &Payload) -> Result<ConfigRulePlan, String> {
    let mut rule_cache: FxHashMap<String, &'static dyn Rule> = FxHashMap::default();
    let mut rules_by_config: Vec<Vec<&'static dyn Rule>> =
        Vec::with_capacity(payload.configs.len());
    for config in &payload.configs {
        let mut config_rules: Vec<&'static dyn Rule> = Vec::new();
        for rule_spec in &config.rules {
            if let Some(leaked) =
                resolve_cached_rule(&mut rule_cache, &rule_spec.name, rule_spec.options.as_ref())?
            {
                push_unique_rule(&mut config_rules, leaked);
            }
        }
        rules_by_config.push(config_rules);
    }
    Ok(ConfigRulePlan {
        rules_by_config,
        file_to_config: files_by_config(payload),
    })
}

#[derive(Default)]
pub(crate) struct RulePlanCache {
    plans: FxHashMap<String, ConfigRulePlan>,
}

impl RulePlanCache {
    pub(crate) fn get(&mut self, payload: &Payload) -> Result<&ConfigRulePlan, String> {
        let mut key = String::new();
        for config in &payload.configs {
            key.push('\u{1}');
            for rule_spec in &config.rules {
                key.push('\0');
                key.push_str(&rule_spec.name);
                key.push('\0');
                key.push_str(
                    &rule_spec
                        .options
                        .as_ref()
                        .map_or_else(String::new, ToString::to_string),
                );
            }
        }
        let plan = match self.plans.entry(key) {
            std::collections::hash_map::Entry::Occupied(entry) => {
                let plan = entry.into_mut();
                plan.file_to_config = files_by_config(payload);
                plan
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(build_config_rule_plan(payload)?)
            }
        };
        Ok(plan)
    }
}

pub(crate) fn lint_program_files(
    program: &'static Program,
    source_files: &[P<SourceFile>],
    plan: &ConfigRulePlan,
    opts: &Options,
    out_diags: &mut Vec<Diagnostic>,
) {
    let mut groups: BTreeMap<usize, Vec<P<SourceFile>>> = BTreeMap::new();
    for &sf in source_files {
        let normalized = tspath::normalize_slashes(sf.file_name());
        let Some(&config_idx) = plan.file_to_config.get(&normalized) else {
            continue;
        };
        groups.entry(config_idx).or_default().push(sf);
    }
    for (config_idx, files) in groups {
        let Some(active_rules) = plan
            .rules_by_config
            .get(config_idx)
            .filter(|rules| !rules.is_empty())
        else {
            continue;
        };
        for item in &lint_files(program, &files, active_rules, opts) {
            if item.rule_name.starts_with("antidrift/")
                && is_inline_disabled(item.file.text(), item.pos, item.end, item.rule_name)
            {
                continue;
            }
            out_diags.push(item.to_protocol());
        }
    }
}
