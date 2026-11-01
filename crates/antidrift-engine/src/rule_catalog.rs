use std::path::Path;

use antidrift_kernel::registries::PolicyRegistries;
use rustc_hash::{FxHashMap, FxHashSet};
use tsrslint::rule::Rule;

use crate::rule_plan::{
    all_scoped_rules, default_workspace_rules, instantiate_rule, push_unique_rule,
};

pub struct RuleRequest {
    pub name: String,
    pub options: Option<String>,
}

pub(crate) struct RequestedRule {
    pub(crate) identity: String,
    pub(crate) rule: &'static dyn Rule,
}

fn rule_identity(name: &str, options: Option<&serde_json::Value>) -> String {
    match options {
        Some(value) => format!("{name}\u{0}{value}"),
        None => name.to_owned(),
    }
}

fn decode_rule_options(
    name: &str,
    options: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(text) = options else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|err| format!("{name}: the host sent rule options that are not JSON: {err}"))?;
    let serde_json::Value::Array(items) = value else {
        return Err(format!(
            "{name}: the host must send rule options as the ESLint options array, got {value}"
        ));
    };
    match items.as_slice() {
        [] => Ok(None),
        [single] => Ok(Some(single.clone())),
        _ => Err(format!(
            "{name}: antidrift rules take one options object, the host sent {} values",
            items.len()
        )),
    }
}

#[derive(Default)]
pub(crate) struct RuleCatalog {
    defaults: FxHashMap<&'static str, &'static dyn Rule>,
    configured: FxHashMap<String, &'static dyn Rule>,
}

impl RuleCatalog {
    pub(crate) fn load(cwd: &Path) -> Result<Self, String> {
        let registries = PolicyRegistries::load_from_repo(cwd)?;
        let mut catalog = default_workspace_rules(&registries)?;
        for rule in all_scoped_rules() {
            push_unique_rule(&mut catalog, rule);
        }
        Ok(Self {
            defaults: catalog
                .into_iter()
                .map(|rule| (rule.name(), rule))
                .collect(),
            configured: FxHashMap::default(),
        })
    }

    pub(crate) fn resolve(&mut self, request: &RuleRequest) -> Result<RequestedRule, String> {
        let name = request.name.as_str();
        let default = self.defaults.get(name).copied().ok_or_else(|| {
            format!("{name} is not an antidrift rule; the plugin registers only the rules the addon lists")
        })?;
        let Some(options) = decode_rule_options(name, request.options.as_deref())? else {
            return Ok(RequestedRule {
                identity: rule_identity(name, None),
                rule: default,
            });
        };
        let identity = rule_identity(name, Some(&options));
        if let Some(&rule) = self.configured.get(&identity) {
            return Ok(RequestedRule { identity, rule });
        }
        let rule = instantiate_rule(name, Some(&options))?
            .ok_or_else(|| format!("rule '{name}' is cataloged but no family factory builds it"))?;
        self.configured.insert(identity.clone(), rule);
        Ok(RequestedRule { identity, rule })
    }
}

#[must_use]
pub fn rule_listing() -> Vec<(String, bool)> {
    let mut seen = FxHashSet::default();
    antidrift_rules::all_entries()
        .into_iter()
        .map(|entry| (entry.rule.name().to_owned(), entry.default_enabled))
        .filter(|(name, _)| seen.insert(name.clone()))
        .collect()
}
