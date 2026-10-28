pub mod batch1;
pub mod batch2;
pub mod batch3;

use tsrslint::rule::Rule;

#[must_use]
pub fn default_typed_rules() -> Vec<&'static dyn Rule> {
    let mut rules = Vec::new();
    rules.extend(batch1::rules());
    rules.extend(batch2::rules());
    rules.extend(batch3::rules());
    rules
}

#[must_use]
pub fn all_typed_rules() -> Vec<&'static dyn Rule> {
    let mut rules = Vec::new();
    rules.extend(batch1::rules());
    rules.extend(batch2::rules());
    rules.extend(batch3::all_rules());
    rules
}

pub fn create_typed_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    if let Some(rule) = batch1::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    if let Some(rule) = batch2::create_rule(name, options)? {
        return Ok(Some(rule));
    }
    batch3::create_rule(name, options)
}
