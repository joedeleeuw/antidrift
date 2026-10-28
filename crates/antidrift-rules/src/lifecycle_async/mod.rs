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

use tsrslint::rule::Rule;

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_async_array_method::DEFAULT_RULE,
        &no_async_context_enter_with::DEFAULT_RULE,
        &no_awaited_builder_union::DEFAULT_RULE,
        &no_eager_singleton::DEFAULT_RULE,
        &no_sentinel_absence_fallback::DEFAULT_RULE,
        &no_spread_input_in_query_key::DEFAULT_RULE,
        &require_fetch_timeout::DEFAULT_RULE,
        &require_function_replacer::DEFAULT_RULE,
        &require_query_key_factory::DEFAULT_RULE,
        &require_query_signal::DEFAULT_RULE,
        &require_stream_reader_disposal::DEFAULT_RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        no_async_array_method::RULE_NAME | "no-async-array-method" => Ok(Some(Box::new(
            no_async_array_method::NoAsyncArrayMethod::from_options(options)?,
        ))),
        no_async_context_enter_with::RULE_NAME | "no-async-context-enter-with" => Ok(Some(
            Box::new(no_async_context_enter_with::NoAsyncContextEnterWith::from_options(options)?),
        )),
        no_awaited_builder_union::RULE_NAME | "no-awaited-builder-union" => Ok(Some(Box::new(
            no_awaited_builder_union::NoAwaitedBuilderUnion::from_options(options)?,
        ))),
        no_eager_singleton::RULE_NAME | "no-eager-singleton" => Ok(Some(Box::new(
            no_eager_singleton::NoEagerSingleton::from_options(options)?,
        ))),
        no_sentinel_absence_fallback::RULE_NAME | "no-sentinel-absence-fallback" => {
            Ok(Some(Box::new(
                no_sentinel_absence_fallback::NoSentinelAbsenceFallback::from_options(options)?,
            )))
        }
        no_spread_input_in_query_key::RULE_NAME | "no-spread-input-in-query-key" => Ok(Some(
            Box::new(no_spread_input_in_query_key::NoSpreadInputInQueryKey::from_options(options)?),
        )),
        require_fetch_timeout::RULE_NAME | "require-fetch-timeout" => Ok(Some(Box::new(
            require_fetch_timeout::RequireFetchTimeout::from_options(options)?,
        ))),
        require_function_replacer::RULE_NAME | "require-function-replacer" => Ok(Some(Box::new(
            require_function_replacer::RequireFunctionReplacer::from_options(options)?,
        ))),
        require_query_key_factory::RULE_NAME | "require-query-key-factory" => Ok(Some(Box::new(
            require_query_key_factory::RequireQueryKeyFactory::from_options(options)?,
        ))),
        require_query_signal::RULE_NAME | "require-query-signal" => Ok(Some(Box::new(
            require_query_signal::RequireQuerySignal::from_options(options)?,
        ))),
        require_stream_reader_disposal::RULE_NAME | "require-stream-reader-disposal" => {
            Ok(Some(Box::new(
                require_stream_reader_disposal::RequireStreamReaderDisposal::from_options(options)?,
            )))
        }
        _ => Ok(None),
    }
}
