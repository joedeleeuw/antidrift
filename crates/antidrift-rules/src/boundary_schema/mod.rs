pub mod no_external_decode_in_tsx;
pub mod no_redundant_zod_parse;
pub mod no_sql_string_concat;
pub mod require_convex_return_validator;
pub mod schema_transforms;
mod sql_tag_provenance;
mod sql_text;
pub mod unknown_input_must_be_decoded;
pub mod unknown_input_probe;

use crate::CatalogRule;

#[must_use]
pub fn typescript_only_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::configured_everywhere(&unknown_input_must_be_decoded::DEFAULT_RULE),
        CatalogRule::everywhere(&no_external_decode_in_tsx::DEFAULT_RULE),
        CatalogRule::everywhere(&no_redundant_zod_parse::DEFAULT_RULE),
        CatalogRule::everywhere(&schema_transforms::NO_IDENTITY_SCHEMA_TRANSFORM),
        CatalogRule::everywhere(&schema_transforms::NO_SCHEMA_VALIDATOR_TRANSCODING),
        CatalogRule::configured_everywhere(&require_convex_return_validator::DEFAULT_RULE),
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::everywhere(&schema_transforms::NO_UNSAFE_DESERIALIZE),
        CatalogRule::configured_everywhere(&no_sql_string_concat::DEFAULT_RULE),
    ]
}
