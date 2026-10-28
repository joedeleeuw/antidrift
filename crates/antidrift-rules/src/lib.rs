pub mod boundary_schema;
pub mod contracts_shape;
pub mod directives;
pub mod lifecycle_async;
pub mod react_ui;
pub mod security_boundaries;
pub mod test_oracle;
pub mod type_narrowing;

use tsrslint::rule::Rule;

#[must_use]
pub fn default_rules() -> Vec<&'static dyn Rule> {
    let mut rules = Vec::new();
    rules.extend(boundary_schema::rules());
    rules.extend(contracts_shape::rules());
    rules.extend(type_narrowing::rules());
    rules.extend(directives::rules());
    rules.extend(lifecycle_async::rules());
    rules.extend(react_ui::rules());
    rules.extend(security_boundaries::rules());
    rules.extend(test_oracle::rules());
    rules
}

#[must_use]
pub fn all_rules() -> Vec<&'static dyn Rule> {
    let mut rules = Vec::new();
    rules.extend(boundary_schema::rules());
    rules.extend(contracts_shape::rules());
    rules.extend(type_narrowing::all_rules());
    rules.extend(directives::rules());
    rules.extend(lifecycle_async::rules());
    rules.extend(react_ui::rules());
    rules.extend(security_boundaries::rules());
    rules.extend(test_oracle::rules());
    rules
}

#[must_use]
pub fn is_typescript_only_rule(name: &str) -> bool {
    matches!(
        name,
        "antidrift/unknown-input-must-be-decoded"
            | "antidrift/no-unsafe-deserialize"
            | "antidrift/no-redundant-zod-parse"
            | "antidrift/no-identity-schema-transform"
            | "antidrift/no-schema-validator-transcoding"
            | "antidrift/require-convex-return-validator"
            | "antidrift/no-sql-string-concat"
            | "antidrift/no-contract-appeasement-projection"
            | "antidrift/no-structural-type-fork"
            | "antidrift/no-nullable-positional-tuple"
            | "antidrift/react-max-component-props"
            | "antidrift/no-explicit-type-arguments-on-owned-api"
            | "antidrift/no-service-constructor-imports"
            | "antidrift/no-appeasement-cast"
            | "antidrift/no-appeasement-erasure"
            | "antidrift/no-redundant-type-predicate"
            | "antidrift/no-underchecked-type-predicate"
            | "antidrift/no-wrapping-functions"
            | "antidrift/no-unresolved-dependency-types"
    )
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
