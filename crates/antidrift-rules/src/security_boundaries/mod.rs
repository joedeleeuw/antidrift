pub mod confine_owner;
pub mod no_auth_token_in_web_storage;
pub mod no_bun_api_in_shared;
pub mod no_path_prefix_containment;
pub mod no_raw_filename_write;
pub mod no_redeclared_owned_union;
pub mod no_relative_cross_package_imports;
pub mod no_unlisted_external_imports;
pub mod no_unsafe_inner_html;
pub mod no_unsanitized_href;
mod owned_union_source;
mod package_ownership;
mod package_resolution;
pub mod require_authz_check;
pub mod require_safe_window_open;
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
            &no_bun_api_in_shared::DEFAULT_RULE,
            ScopePolicy::InferredRole(no_bun_api_in_shared::inferred_role),
        ),
        CatalogRule::everywhere(&no_path_prefix_containment::DEFAULT_RULE),
        CatalogRule::everywhere(&no_raw_filename_write::DEFAULT_RULE),
        CatalogRule::everywhere(&no_relative_cross_package_imports::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_unlisted_external_imports::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_unsafe_inner_html::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_unsanitized_href::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&require_authz_check::DEFAULT_RULE),
        CatalogRule::everywhere(&require_safe_window_open::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&require_secure_document_response::DEFAULT_RULE),
    ]
}
