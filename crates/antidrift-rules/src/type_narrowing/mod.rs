mod call_forwarding;
pub mod erasure_analysis;
pub mod no_appeasement_cast;
pub mod no_appeasement_erasure;
pub mod no_argument_mutation_side_effect;
pub mod no_closed_string_parameter;
pub mod no_compat_names;
pub mod no_pass_through_parameters;
pub mod no_redundant_type_predicate;
pub mod no_underchecked_type_predicate;
pub mod no_unresolved_dependency_types;
pub mod no_vague_names;
pub mod no_wrapping_functions;
pub mod predicate_scan;
mod vague_name_lexicon;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn typescript_only_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::everywhere(&no_appeasement_cast::DEFAULT_INSTANCE),
        CatalogRule::everywhere(&no_appeasement_erasure::DEFAULT_INSTANCE),
        CatalogRule::everywhere(&no_redundant_type_predicate::DEFAULT_INSTANCE),
        CatalogRule::everywhere(&no_underchecked_type_predicate::DEFAULT_INSTANCE),
        CatalogRule::new(
            &no_wrapping_functions::DEFAULT_INSTANCE,
            ScopePolicy::ExceptGenerated,
        ),
        CatalogRule::everywhere(&no_unresolved_dependency_types::DEFAULT_INSTANCE),
        CatalogRule::new(
            &no_closed_string_parameter::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
        CatalogRule::new(
            &no_argument_mutation_side_effect::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::new(
            &no_pass_through_parameters::DEFAULT_INSTANCE,
            ScopePolicy::ExceptGenerated,
        ),
        CatalogRule::everywhere(&no_compat_names::DEFAULT_INSTANCE),
    ]
}

#[must_use]
pub fn default_off_rules() -> Vec<CatalogRule> {
    vec![CatalogRule::everywhere(&no_vague_names::DEFAULT_INSTANCE)]
}
