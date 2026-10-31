#![forbid(unsafe_code)]

pub mod boundary_schema;
pub mod contracts_shape;
pub mod directives;
pub mod lifecycle_async;
pub mod react_ui;
pub mod security_boundaries;
pub mod test_oracle;
pub mod type_narrowing;

use antidrift_kernel::scope_policy::ScopePolicy;
use std::sync::LazyLock;
use tsrslint::rule::Rule;

pub struct CatalogRule {
    pub rule: &'static dyn Rule,
    pub scope_policy: ScopePolicy,
}

impl CatalogRule {
    #[must_use]
    pub const fn new(rule: &'static dyn Rule, scope_policy: ScopePolicy) -> Self {
        Self { rule, scope_policy }
    }

    #[must_use]
    pub const fn everywhere(rule: &'static dyn Rule) -> Self {
        Self::new(rule, ScopePolicy::Everywhere)
    }
}

pub struct RuleCatalogEntry {
    pub rule: &'static dyn Rule,
    pub scope_policy: ScopePolicy,
    pub default_enabled: bool,
    pub typescript_only: bool,
}

type FamilyFactory = fn(&str, Option<&serde_json::Value>) -> Result<Option<Box<dyn Rule>>, String>;

const FAMILY_FACTORIES: &[FamilyFactory] = &[
    boundary_schema::create_rule,
    contracts_shape::create_rule,
    type_narrowing::create_rule,
    directives::create_rule,
    lifecycle_async::create_rule,
    react_ui::create_rule,
    security_boundaries::create_rule,
    test_oracle::create_rule,
];

fn push_entries(
    out: &mut Vec<RuleCatalogEntry>,
    rules: Vec<CatalogRule>,
    default_enabled: bool,
    typescript_only: bool,
) {
    for CatalogRule { rule, scope_policy } in rules {
        out.push(RuleCatalogEntry {
            rule,
            scope_policy,
            default_enabled,
            typescript_only,
        });
    }
}

static RULE_CATALOG: LazyLock<Vec<RuleCatalogEntry>> = LazyLock::new(|| {
    let mut entries = Vec::with_capacity(88);
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

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    for factory in FAMILY_FACTORIES {
        if let Some(rule) = factory(name, options)? {
            return Ok(Some(rule));
        }
    }
    Ok(None)
}
