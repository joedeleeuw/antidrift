pub mod no_async_array_method;
pub mod no_awaited_builder_union;
pub mod no_sentinel_absence_fallback;
pub mod no_spread_input_in_query_key;
pub mod require_fetch_timeout;
pub mod require_query_key_factory;
pub mod require_query_signal;
pub mod require_stream_reader_disposal;
pub mod runtime_primitives;
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
        CatalogRule::everywhere(&runtime_primitives::NO_ASYNC_CONTEXT_ENTER_WITH),
        CatalogRule::everywhere(&no_awaited_builder_union::DEFAULT_RULE),
        CatalogRule::configured(
            &runtime_primitives::NO_EAGER_SINGLETON,
            ScopePolicy::InferredRole(runtime_primitives::singleton_inferred_role),
        ),
        CatalogRule::configured_everywhere(&no_sentinel_absence_fallback::DEFAULT_RULE),
        CatalogRule::everywhere(&no_spread_input_in_query_key::DEFAULT_RULE),
        CatalogRule::everywhere(&require_fetch_timeout::DEFAULT_RULE),
        CatalogRule::everywhere(&runtime_primitives::REQUIRE_FUNCTION_REPLACER),
        CatalogRule::everywhere(&require_query_key_factory::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&require_query_signal::DEFAULT_RULE),
        CatalogRule::everywhere(&require_stream_reader_disposal::DEFAULT_RULE),
    ]
}
