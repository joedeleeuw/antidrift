pub mod erasure_analysis;
pub mod no_appeasement_cast;
pub mod no_appeasement_erasure;
pub mod no_compat_names;
pub mod no_pass_through_parameters;
pub mod no_redundant_type_predicate;
pub mod no_underchecked_type_predicate;
pub mod no_unresolved_dependency_types;
pub mod no_vague_names;
pub mod no_wrapping_functions;
pub mod predicate_scan;

use antidrift_kernel::rule_scope::ScopeOptions;
use antidrift_kernel::rule_scope::decode_rule_options;
use tsrslint::rule::Rule;

#[must_use]
pub fn typescript_only_rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_appeasement_cast::NoAppeasementCast,
        &no_appeasement_erasure::NoAppeasementErasure,
        &no_redundant_type_predicate::NoRedundantTypePredicate,
        &no_underchecked_type_predicate::NoUndercheckedTypePredicate,
        &no_wrapping_functions::DEFAULT_INSTANCE,
        &no_unresolved_dependency_types::NoUnresolvedDependencyTypes,
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_pass_through_parameters::DEFAULT_INSTANCE,
        &no_compat_names::DEFAULT_INSTANCE,
    ]
}

#[must_use]
pub fn default_off_rules() -> Vec<&'static dyn Rule> {
    vec![&no_vague_names::DEFAULT_INSTANCE]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        "antidrift/no-appeasement-cast" | "no-appeasement-cast" => {
            decode_rule_options::<ScopeOptions>("antidrift/no-appeasement-cast", options)?;
            Ok(Some(Box::new(no_appeasement_cast::NoAppeasementCast)))
        }
        "antidrift/no-appeasement-erasure" | "no-appeasement-erasure" => {
            decode_rule_options::<ScopeOptions>("antidrift/no-appeasement-erasure", options)?;
            Ok(Some(Box::new(no_appeasement_erasure::NoAppeasementErasure)))
        }
        "antidrift/no-redundant-type-predicate" | "no-redundant-type-predicate" => {
            decode_rule_options::<ScopeOptions>("antidrift/no-redundant-type-predicate", options)?;
            Ok(Some(Box::new(
                no_redundant_type_predicate::NoRedundantTypePredicate,
            )))
        }
        "antidrift/no-underchecked-type-predicate" | "no-underchecked-type-predicate" => {
            decode_rule_options::<ScopeOptions>(
                "antidrift/no-underchecked-type-predicate",
                options,
            )?;
            Ok(Some(Box::new(
                no_underchecked_type_predicate::NoUndercheckedTypePredicate,
            )))
        }
        "antidrift/no-wrapping-functions" | "no-wrapping-functions" => {
            Ok(Some(no_wrapping_functions::create(options)?))
        }
        "antidrift/no-pass-through-parameters" | "no-pass-through-parameters" => {
            Ok(Some(no_pass_through_parameters::create(options)?))
        }
        "antidrift/no-unresolved-dependency-types" | "no-unresolved-dependency-types" => {
            decode_rule_options::<ScopeOptions>(
                "antidrift/no-unresolved-dependency-types",
                options,
            )?;
            Ok(Some(Box::new(
                no_unresolved_dependency_types::NoUnresolvedDependencyTypes,
            )))
        }
        "antidrift/no-compat-names" | "no-compat-names" => {
            Ok(Some(no_compat_names::create(options)?))
        }
        "antidrift/no-vague-names" | "no-vague-names" => Ok(Some(no_vague_names::create(options)?)),
        _ => Ok(None),
    }
}
