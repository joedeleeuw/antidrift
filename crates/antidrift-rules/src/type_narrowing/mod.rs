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

use tsrslint::rule::Rule;

#[must_use]
pub fn typescript_only_rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_appeasement_cast::DEFAULT_INSTANCE,
        &no_appeasement_erasure::DEFAULT_INSTANCE,
        &no_redundant_type_predicate::DEFAULT_INSTANCE,
        &no_underchecked_type_predicate::DEFAULT_INSTANCE,
        &no_wrapping_functions::DEFAULT_INSTANCE,
        &no_unresolved_dependency_types::DEFAULT_INSTANCE,
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
        "antidrift/no-appeasement-cast" | "no-appeasement-cast" => Ok(Some(Box::new(
            no_appeasement_cast::NoAppeasementCast::from_options(options)?,
        ))),
        "antidrift/no-appeasement-erasure" | "no-appeasement-erasure" => Ok(Some(Box::new(
            no_appeasement_erasure::NoAppeasementErasure::from_options(options)?,
        ))),
        "antidrift/no-redundant-type-predicate" | "no-redundant-type-predicate" => Ok(Some(
            Box::new(no_redundant_type_predicate::NoRedundantTypePredicate::from_options(options)?),
        )),
        "antidrift/no-underchecked-type-predicate" | "no-underchecked-type-predicate" => {
            Ok(Some(Box::new(
                no_underchecked_type_predicate::NoUndercheckedTypePredicate::from_options(options)?,
            )))
        }
        "antidrift/no-wrapping-functions" | "no-wrapping-functions" => {
            Ok(Some(no_wrapping_functions::create(options)?))
        }
        "antidrift/no-pass-through-parameters" | "no-pass-through-parameters" => {
            Ok(Some(no_pass_through_parameters::create(options)?))
        }
        "antidrift/no-unresolved-dependency-types" | "no-unresolved-dependency-types" => {
            Ok(Some(Box::new(
                no_unresolved_dependency_types::NoUnresolvedDependencyTypes::from_options(options)?,
            )))
        }
        "antidrift/no-compat-names" | "no-compat-names" => {
            Ok(Some(no_compat_names::create(options)?))
        }
        "antidrift/no-vague-names" | "no-vague-names" => Ok(Some(no_vague_names::create(options)?)),
        _ => Ok(None),
    }
}
