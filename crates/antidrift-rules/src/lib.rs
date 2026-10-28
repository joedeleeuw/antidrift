pub mod boundary_schema;
pub mod contracts_shape;
pub mod directives;
pub mod lifecycle_async;
pub mod react_ui;
pub mod security_boundaries;
pub mod test_oracle;
pub mod type_narrowing;

use tsrslint::rule::Rule;

struct RuleCatalogEntry {
    rule: &'static dyn Rule,
    default_enabled: bool,
    typescript_only: bool,
}

fn push_entries(
    out: &mut Vec<RuleCatalogEntry>,
    rules: Vec<&'static dyn Rule>,
    default_enabled: bool,
    typescript_only: bool,
) {
    for rule in rules {
        out.push(RuleCatalogEntry {
            rule,
            default_enabled,
            typescript_only,
        });
    }
}

fn rule_catalog() -> Vec<RuleCatalogEntry> {
    let mut entries = Vec::with_capacity(82);
    push_entries(&mut entries, boundary_schema::rules(), true, true);
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
    push_entries(&mut entries, react_ui::rules(), true, false);
    push_entries(&mut entries, security_boundaries::rules(), true, false);
    push_entries(&mut entries, test_oracle::rules(), true, false);
    entries
}

#[must_use]
pub fn default_rules() -> Vec<&'static dyn Rule> {
    rule_catalog()
        .into_iter()
        .filter(|entry| entry.default_enabled)
        .map(|entry| entry.rule)
        .collect()
}

#[must_use]
pub fn all_rules() -> Vec<&'static dyn Rule> {
    rule_catalog().into_iter().map(|entry| entry.rule).collect()
}

#[must_use]
pub fn is_typescript_only_rule(name: &str) -> bool {
    rule_catalog()
        .into_iter()
        .any(|entry| entry.typescript_only && entry.rule.name() == name)
}

#[must_use]
pub fn lookup_default_rule(name: &str) -> Option<&'static dyn Rule> {
    rule_catalog().into_iter().find_map(|entry| {
        let rule_name = entry.rule.name();
        (rule_name == name || rule_name.strip_prefix("antidrift/") == Some(name))
            .then_some(entry.rule)
    })
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    if let Some(rule) = boundary_schema::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = contracts_shape::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = type_narrowing::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = directives::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = lifecycle_async::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = react_ui::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = security_boundaries::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    test_oracle::create_rule(name, options)
}
