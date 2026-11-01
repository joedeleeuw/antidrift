pub mod no_async_array_method;
pub mod no_async_context_enter_with;
pub mod no_awaited_builder_union;
pub mod no_eager_singleton;
pub mod no_sentinel_absence_fallback;
pub mod no_spread_input_in_query_key;
pub mod require_fetch_timeout;
pub mod require_function_replacer;
pub mod require_query_key_factory;
pub mod require_query_signal;
pub mod require_stream_reader_disposal;
mod stream_cleanup;
mod stream_origin;
mod stream_paths;
mod syntax;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;

#[must_use]
pub fn rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::configured_everywhere(&no_async_array_method::DEFAULT_RULE),
        CatalogRule::everywhere(&no_async_context_enter_with::DEFAULT_RULE),
        CatalogRule::everywhere(&no_awaited_builder_union::DEFAULT_RULE),
        CatalogRule::configured(
            &no_eager_singleton::DEFAULT_RULE,
            ScopePolicy::InferredRole(no_eager_singleton::inferred_role),
        ),
        CatalogRule::configured_everywhere(&no_sentinel_absence_fallback::DEFAULT_RULE),
        CatalogRule::everywhere(&no_spread_input_in_query_key::DEFAULT_RULE),
        CatalogRule::everywhere(&require_fetch_timeout::DEFAULT_RULE),
        CatalogRule::everywhere(&require_function_replacer::DEFAULT_RULE),
        CatalogRule::everywhere(&require_query_key_factory::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&require_query_signal::DEFAULT_RULE),
        CatalogRule::everywhere(&require_stream_reader_disposal::DEFAULT_RULE),
    ]
}
