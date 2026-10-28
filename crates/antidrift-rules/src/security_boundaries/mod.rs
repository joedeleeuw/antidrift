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
mod web_provenance;

use tsrslint::rule::Rule;

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &confine_owner::DEFAULT_RULE,
        &no_auth_token_in_web_storage::DEFAULT_RULE,
        &no_bun_api_in_shared::DEFAULT_RULE,
        &no_path_prefix_containment::DEFAULT_RULE,
        &no_raw_filename_write::DEFAULT_RULE,
        &no_redeclared_owned_union::DEFAULT_RULE,
        &no_relative_cross_package_imports::DEFAULT_RULE,
        &no_unlisted_external_imports::DEFAULT_RULE,
        &no_unsafe_inner_html::DEFAULT_RULE,
        &no_unsanitized_href::DEFAULT_RULE,
        &require_authz_check::DEFAULT_RULE,
        &require_safe_window_open::DEFAULT_RULE,
        &require_secure_document_response::DEFAULT_RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        confine_owner::RULE_NAME | "confine-owner" => Ok(Some(Box::new(
            confine_owner::ConfineOwner::from_options(options)?,
        ))),
        no_auth_token_in_web_storage::RULE_NAME | "no-auth-token-in-web-storage" => Ok(Some(
            Box::new(no_auth_token_in_web_storage::NoAuthTokenInWebStorage::from_options(options)?),
        )),
        no_bun_api_in_shared::RULE_NAME | "no-bun-api-in-shared" => Ok(Some(Box::new(
            no_bun_api_in_shared::NoBunApiInShared::from_options(options)?,
        ))),
        no_path_prefix_containment::RULE_NAME | "no-path-prefix-containment" => Ok(Some(Box::new(
            no_path_prefix_containment::NoPathPrefixContainment::from_options(options)?,
        ))),
        no_raw_filename_write::RULE_NAME | "no-raw-filename-write" => Ok(Some(Box::new(
            no_raw_filename_write::NoRawFilenameWrite::from_options(options)?,
        ))),
        no_redeclared_owned_union::RULE_NAME | "no-redeclared-owned-union" => Ok(Some(Box::new(
            no_redeclared_owned_union::NoRedeclaredOwnedUnion::from_options(options)?,
        ))),
        no_relative_cross_package_imports::RULE_NAME | "no-relative-cross-package-imports" => {
            Ok(Some(Box::new(
                no_relative_cross_package_imports::NoRelativeCrossPackageImports::from_options(
                    options,
                )?,
            )))
        }
        no_unlisted_external_imports::RULE_NAME | "no-unlisted-external-imports" => {
            Ok(Some(Box::new(
                no_unlisted_external_imports::NoUnlistedExternalImports::from_options(options)?,
            )))
        }
        no_unsafe_inner_html::RULE_NAME | "no-unsafe-inner-html" => Ok(Some(Box::new(
            no_unsafe_inner_html::NoUnsafeInnerHtml::from_options(options)?,
        ))),
        no_unsanitized_href::RULE_NAME | "no-unsanitized-href" => Ok(Some(Box::new(
            no_unsanitized_href::NoUnsanitizedHref::from_options(options)?,
        ))),
        require_authz_check::RULE_NAME | "require-authz-check" => Ok(Some(Box::new(
            require_authz_check::RequireAuthzCheck::from_options(options)?,
        ))),
        require_safe_window_open::RULE_NAME | "require-safe-window-open" => Ok(Some(Box::new(
            require_safe_window_open::RequireSafeWindowOpen::from_options(options)?,
        ))),
        require_secure_document_response::RULE_NAME | "require-secure-document-response" => {
            Ok(Some(Box::new(
                require_secure_document_response::RequireSecureDocumentResponse::from_options(
                    options,
                )?,
            )))
        }
        _ => Ok(None),
    }
}
