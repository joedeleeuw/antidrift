pub mod boundary_primitives;
pub mod confine_owner;
pub mod no_auth_token_in_web_storage;
pub mod no_path_prefix_containment;
pub mod no_raw_filename_write;
pub mod no_redeclared_owned_union;
pub mod no_unlisted_external_imports;
pub mod no_unsafe_inner_html;
mod owned_union_source;
mod package_ownership;
mod package_resolution;
pub mod require_authz_check;
pub mod require_secure_document_response;
mod union_owners;
mod web_provenance;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn typescript_only_rules() -> Vec<CatalogRule> {
    vec![CatalogRule::configured_everywhere(
        &no_redeclared_owned_union::DEFAULT_RULE,
    )]
}

#[must_use]
pub fn script_default_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::configured_everywhere(&confine_owner::DEFAULT_RULE),
        CatalogRule::everywhere(&no_auth_token_in_web_storage::DEFAULT_RULE),
        CatalogRule::new(
            &boundary_primitives::NO_BUN_API_IN_SHARED,
            ScopePolicy::SharedOnly,
        ),
        CatalogRule::everywhere(&no_path_prefix_containment::DEFAULT_RULE),
        CatalogRule::everywhere(&no_raw_filename_write::DEFAULT_RULE),
        CatalogRule::everywhere(&boundary_primitives::NO_RELATIVE_CROSS_PACKAGE_IMPORTS),
        CatalogRule::configured_everywhere(&no_unlisted_external_imports::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_unsafe_inner_html::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&boundary_primitives::NO_UNSANITIZED_HREF),
        CatalogRule::configured_everywhere(&require_authz_check::DEFAULT_RULE),
        CatalogRule::everywhere(&boundary_primitives::REQUIRE_SAFE_WINDOW_OPEN),
        CatalogRule::configured_everywhere(&require_secure_document_response::DEFAULT_RULE),
    ]
}
