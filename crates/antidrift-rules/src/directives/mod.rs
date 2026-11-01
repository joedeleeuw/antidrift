mod alias_usage_scan;
mod anemic_error_fallback;
mod classifier_schema;
pub mod docs_source_policy;
pub mod line_caps;
pub mod no_anemic_errors;
pub mod no_as_never;
pub mod no_branch_tree;
pub mod no_dated_comments;
pub mod no_debug_residue_filenames;
pub mod no_default_export_in_domain;
pub mod no_host_path_literal;
pub mod no_mutable_let_alias;
pub mod no_partial_record_satisfies;
pub mod no_reexport_only_module;
pub mod no_todo_without_issue;
pub mod no_tutorial_comments;
pub mod no_unknown_type_aliases;
pub mod no_unsafe_cast_chain;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::configured_everywhere(&docs_source_policy::DEFAULT_RULE),
        CatalogRule::everywhere(&line_caps::MODULE_RULE),
        CatalogRule::everywhere(&line_caps::FUNCTION_RULE),
        CatalogRule::everywhere(&line_caps::COMPONENT_RULE),
        CatalogRule::everywhere(&no_anemic_errors::DEFAULT_RULE),
        CatalogRule::everywhere(&no_as_never::DEFAULT_RULE),
        CatalogRule::everywhere(&no_branch_tree::DEFAULT_RULE),
        CatalogRule::everywhere(&no_dated_comments::DEFAULT_RULE),
        CatalogRule::everywhere(&no_debug_residue_filenames::DEFAULT_RULE),
        CatalogRule::new(
            &no_default_export_in_domain::DEFAULT_RULE,
            ScopePolicy::InferredRole(no_default_export_in_domain::inferred_role),
        ),
        CatalogRule::new(
            &no_host_path_literal::DEFAULT_RULE,
            ScopePolicy::InferredRole(no_host_path_literal::inferred_role),
        ),
        CatalogRule::everywhere(&no_mutable_let_alias::DEFAULT_RULE),
        CatalogRule::everywhere(&no_partial_record_satisfies::DEFAULT_RULE),
        CatalogRule::new(
            &no_reexport_only_module::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
        CatalogRule::everywhere(&no_todo_without_issue::DEFAULT_RULE),
        CatalogRule::everywhere(&no_tutorial_comments::DEFAULT_RULE),
        CatalogRule::everywhere(&no_unknown_type_aliases::DEFAULT_RULE),
        CatalogRule::everywhere(&no_unsafe_cast_chain::DEFAULT_RULE),
    ]
}
