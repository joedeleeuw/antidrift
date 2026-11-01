#![forbid(unsafe_code)]

pub mod boundary_schema;
pub mod contracts_shape;
pub mod directives;
pub mod lifecycle_async;
pub mod react_ui;
pub mod security_boundaries;
pub mod test_oracle;
pub mod type_narrowing;

use antidrift_kernel::rule::Rule;
use antidrift_kernel::rule_options::{decode_rule_options, reject_unknown_options};
use antidrift_kernel::scope_policy::ScopePolicy;
use serde::de::DeserializeOwned;
use std::sync::LazyLock;

pub(crate) trait ConfigurableRule: Rule + Sized + 'static {
    type Options: DeserializeOwned + Default;

    fn from_options(options: Self::Options) -> Result<Self, String>;
}

pub type OptionFactory =
    fn(&'static str, Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String>;

fn decode_configured<R: ConfigurableRule>(
    rule_name: &'static str,
    options: Option<&serde_json::Value>,
) -> Result<Box<dyn Rule>, String> {
    let parsed =
        decode_rule_options::<R::Options>(rule_name, options).map_err(|err| err.to_string())?;
    Ok(Box::new(R::from_options(parsed)?))
}

pub struct CatalogRule {
    pub rule: &'static dyn Rule,
    pub scope_policy: ScopePolicy,
    pub factory: Option<OptionFactory>,
}

impl CatalogRule {
    #[must_use]
    pub const fn new(rule: &'static dyn Rule, scope_policy: ScopePolicy) -> Self {
        Self {
            rule,
            scope_policy,
            factory: None,
        }
    }

    #[must_use]
    pub const fn everywhere(rule: &'static dyn Rule) -> Self {
        Self::new(rule, ScopePolicy::Everywhere)
    }

    #[must_use]
    pub(crate) const fn configured<R: ConfigurableRule>(
        rule: &'static R,
        scope_policy: ScopePolicy,
    ) -> Self {
        Self {
            rule,
            scope_policy,
            factory: Some(decode_configured::<R>),
        }
    }

    #[must_use]
    pub(crate) const fn configured_everywhere<R: ConfigurableRule>(rule: &'static R) -> Self {
        Self::configured(rule, ScopePolicy::Everywhere)
    }
}

pub struct RuleCatalogEntry {
    pub rule: &'static dyn Rule,
    pub scope_policy: ScopePolicy,
    pub default_enabled: bool,
    pub typescript_only: bool,
    pub factory: Option<OptionFactory>,
}

impl RuleCatalogEntry {
    pub fn instantiate(
        &self,
        options: Option<&serde_json::Value>,
    ) -> Result<&'static dyn Rule, String> {
        let rule_name = self.rule.name();
        match (self.factory, options) {
            (_, None) => Ok(self.rule),
            (None, Some(_)) => {
                reject_unknown_options(rule_name, options)?;
                Ok(self.rule)
            }
            (Some(factory), Some(_)) => Ok(Box::leak(factory(rule_name, options)?)),
        }
    }
}

fn push_entries(
    out: &mut Vec<RuleCatalogEntry>,
    rules: Vec<CatalogRule>,
    default_enabled: bool,
    typescript_only: bool,
) {
    for CatalogRule {
        rule,
        scope_policy,
        factory,
    } in rules
    {
        out.push(RuleCatalogEntry {
            rule,
            scope_policy,
            default_enabled,
            typescript_only,
            factory,
        });
    }
}

static RULE_CATALOG: LazyLock<Vec<RuleCatalogEntry>> = LazyLock::new(|| {
    let mut entries = Vec::with_capacity(98);
    push_entries(
        &mut entries,
        boundary_schema::typescript_only_rules(),
        true,
        true,
    );
    push_entries(
        &mut entries,
        boundary_schema::script_default_rules(),
        true,
        false,
    );
    push_entries(&mut entries, contracts_shape::rules(), true, true);
    push_entries(
        &mut entries,
        type_narrowing::typescript_only_rules(),
        true,
        true,
    );
    push_entries(
        &mut entries,
        type_narrowing::script_default_rules(),
        true,
        false,
    );
    push_entries(
        &mut entries,
        type_narrowing::default_off_rules(),
        false,
        false,
    );
    push_entries(&mut entries, directives::rules(), true, false);
    push_entries(&mut entries, lifecycle_async::rules(), true, false);
    push_entries(&mut entries, react_ui::typescript_only_rules(), true, true);
    push_entries(&mut entries, react_ui::script_default_rules(), true, false);
    push_entries(
        &mut entries,
        security_boundaries::typescript_only_rules(),
        true,
        true,
    );
    push_entries(
        &mut entries,
        security_boundaries::script_default_rules(),
        true,
        false,
    );
    push_entries(&mut entries, test_oracle::rules(), true, false);
    entries
});

#[must_use]
pub fn default_entries() -> Vec<&'static RuleCatalogEntry> {
    RULE_CATALOG
        .iter()
        .filter(|entry| entry.default_enabled)
        .collect()
}

#[must_use]
pub fn all_entries() -> Vec<&'static RuleCatalogEntry> {
    RULE_CATALOG.iter().collect()
}

#[must_use]
pub fn all_rules() -> Vec<&'static dyn Rule> {
    RULE_CATALOG.iter().map(|entry| entry.rule).collect()
}

#[must_use]
pub fn is_typescript_only_rule(name: &str) -> bool {
    RULE_CATALOG
        .iter()
        .any(|entry| entry.typescript_only && entry.rule.name() == name)
}

#[must_use]
pub fn lookup_entry(name: &str) -> Option<&'static RuleCatalogEntry> {
    RULE_CATALOG.iter().find(|entry| {
        let rule_name = entry.rule.name();
        rule_name == name || rule_name.strip_prefix("antidrift/") == Some(name)
    })
}
