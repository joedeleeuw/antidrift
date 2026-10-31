use crate::error::KernelError;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tsrs_ast::Node;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, RuleVisitor};

pub struct EmptyVisitor;

impl RuleVisitor for EmptyVisitor {
    fn listeners(&self) -> &[Listener] {
        &[]
    }

    fn visit(&mut self, _ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {}
}

pub fn require_non_empty(
    rule_name: &str,
    field: &str,
    text: Option<&String>,
) -> Result<(), String> {
    if text.is_some_and(String::is_empty) {
        return Err(format!(
            "invalid options for {rule_name}: '{field}' must be a non-empty string"
        ));
    }
    Ok(())
}

fn first_option_object(options: Option<&Value>) -> Option<&Value> {
    let raw = options?;
    if raw.is_null() {
        return None;
    }
    match raw.as_array() {
        Some(entries) => entries.first().filter(|first| !first.is_null()),
        None => Some(raw),
    }
}

pub fn decode_rule_options<T: DeserializeOwned + Default>(
    rule_name: &str,
    options: Option<&Value>,
) -> Result<T, KernelError> {
    let Some(target) = first_option_object(options) else {
        return Ok(T::default());
    };
    serde_json::from_value::<T>(target.clone()).map_err(|source| KernelError::JsonDecode {
        location: format!("invalid options for {rule_name}"),
        source,
    })
}

pub fn reject_unknown_options(rule_name: &str, options: Option<&Value>) -> Result<(), String> {
    let Some(target) = first_option_object(options) else {
        return Ok(());
    };
    let keys: Vec<&str> = match target {
        Value::Object(fields) if fields.is_empty() => return Ok(()),
        Value::Object(fields) => fields.keys().map(String::as_str).collect(),
        _ => Vec::new(),
    };
    Err(format!(
        "invalid options for {rule_name}: this rule takes no options besides files and excludeFiles (got {})",
        if keys.is_empty() {
            target.to_string()
        } else {
            keys.join(", ")
        }
    ))
}
