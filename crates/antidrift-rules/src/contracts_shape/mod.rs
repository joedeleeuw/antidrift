pub mod no_contract_appeasement_projection;
pub mod no_explicit_type_arguments_on_owned_api;
pub mod no_hypothetical_seam;
pub mod no_structural_type_fork;
pub mod react_max_component_props;
pub mod redundant_local_return;
pub mod structural_fork_analysis;
mod test_only_seam;
pub mod tuple_and_service_shape;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::new(
            &no_contract_appeasement_projection::RULE,
            ScopePolicy::ExceptGenerated,
        ),
        CatalogRule::configured_everywhere(&no_structural_type_fork::RULE),
        CatalogRule::everywhere(&tuple_and_service_shape::NO_NULLABLE_POSITIONAL_TUPLE),
        CatalogRule::configured_everywhere(&react_max_component_props::RULE),
        CatalogRule::everywhere(&no_explicit_type_arguments_on_owned_api::RULE),
        CatalogRule::everywhere(&tuple_and_service_shape::NO_SERVICE_CONSTRUCTOR_IMPORTS),
        CatalogRule::new(
            &no_hypothetical_seam::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
    ]
}
