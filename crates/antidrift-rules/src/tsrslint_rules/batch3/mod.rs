pub mod erasure_helpers;
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
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_appeasement_cast::NoAppeasementCast,
        &no_appeasement_erasure::NoAppeasementErasure,
        &no_redundant_type_predicate::NoRedundantTypePredicate,
        &no_underchecked_type_predicate::NoUndercheckedTypePredicate,
        &no_wrapping_functions::DEFAULT_INSTANCE,
        &no_pass_through_parameters::DEFAULT_INSTANCE,
        &no_unresolved_dependency_types::NoUnresolvedDependencyTypes,
        &no_compat_names::DEFAULT_INSTANCE,
    ]
}

#[must_use]
pub fn create_rule(name: &str, options: Option<&serde_json::Value>) -> Option<Box<dyn Rule>> {
    match name {
        "antidrift/no-appeasement-cast" | "no-appeasement-cast" => {
            Some(no_appeasement_cast::create(options))
        }
        "antidrift/no-appeasement-erasure" | "no-appeasement-erasure" => {
            Some(no_appeasement_erasure::create(options))
        }
        "antidrift/no-redundant-type-predicate" | "no-redundant-type-predicate" => {
            Some(no_redundant_type_predicate::create(options))
        }
        "antidrift/no-underchecked-type-predicate" | "no-underchecked-type-predicate" => {
            Some(no_underchecked_type_predicate::create(options))
        }
        "antidrift/no-wrapping-functions" | "no-wrapping-functions" => {
            Some(no_wrapping_functions::create(options))
        }
        "antidrift/no-pass-through-parameters" | "no-pass-through-parameters" => {
            Some(no_pass_through_parameters::create(options))
        }
        "antidrift/no-unresolved-dependency-types" | "no-unresolved-dependency-types" => {
            Some(no_unresolved_dependency_types::create(options))
        }
        "antidrift/no-compat-names" | "no-compat-names" => Some(no_compat_names::create(options)),
        "antidrift/no-vague-names" | "no-vague-names" => Some(no_vague_names::create(options)),
        _ => None,
    }
}
