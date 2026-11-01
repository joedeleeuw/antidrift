use crate::error::KernelError;
use crate::rule::{Ctx, Listener, RuleVisitor};
use serde::Deserialize;
use serde::de::{DeserializeOwned, Error};
use serde_json::Value;
use tsrs_ast::Node;
use tsrs_core::P;

pub struct EmptyVisitor;

impl RuleVisitor for EmptyVisitor {
    fn listeners(&self) -> &[Listener] {
        &[]
    }

    fn visit(&mut self, _ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {}
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct NonEmptyString(String);

impl NonEmptyString {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::ops::Deref for NonEmptyString {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub fn deserialize_non_empty<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    field: &'static str,
) -> Result<NonEmptyString, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(D::Error::custom(format!(
            "'{field}' must be a non-empty string"
        )));
    }
    Ok(NonEmptyString(value))
}

pub fn deserialize_optional_non_empty<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    field: &'static str,
) -> Result<Option<NonEmptyString>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    match value {
        Some(text) if text.is_empty() => Err(D::Error::custom(format!(
            "'{field}' must be a non-empty string"
        ))),
        Some(text) => Ok(Some(NonEmptyString(text))),
        None => Ok(None),
    }
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
