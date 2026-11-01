mod alias_usage_scan;
mod anemic_error_fallback;
mod classifier_schema;
pub mod comment_directives;
pub mod docs_source_policy;
pub mod line_caps;
pub mod no_anemic_errors;
pub mod no_branch_tree;
pub mod no_mutable_let_alias;
pub mod no_reexport_only_module;
pub mod no_todo_without_issue;
pub mod syntax_directives;

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
        CatalogRule::everywhere(&syntax_directives::NO_AS_NEVER),
        CatalogRule::everywhere(&no_branch_tree::DEFAULT_RULE),
        CatalogRule::everywhere(&comment_directives::NO_DATED_COMMENTS),
        CatalogRule::everywhere(&syntax_directives::NO_DEBUG_RESIDUE_FILENAMES),
        CatalogRule::new(
            &syntax_directives::NO_HOST_PATH_LITERAL,
            ScopePolicy::NonExampleSource,
        ),
        CatalogRule::everywhere(&no_mutable_let_alias::DEFAULT_RULE),
        CatalogRule::everywhere(&syntax_directives::NO_PARTIAL_RECORD_SATISFIES),
        CatalogRule::new(
            &no_reexport_only_module::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
        CatalogRule::everywhere(&no_todo_without_issue::DEFAULT_RULE),
        CatalogRule::everywhere(&comment_directives::NO_TUTORIAL_COMMENTS),
        CatalogRule::everywhere(&syntax_directives::NO_UNKNOWN_TYPE_ALIASES),
        CatalogRule::everywhere(&syntax_directives::NO_UNSAFE_CAST_CHAIN),
    ]
}
