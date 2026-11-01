pub mod no_external_decode_in_tsx;
pub mod no_identity_schema_transform;
pub mod no_redundant_zod_parse;
pub mod no_schema_validator_transcoding;
pub mod no_sql_string_concat;
pub mod no_unsafe_deserialize;
pub mod require_convex_return_validator;
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
        CatalogRule::everywhere(&no_identity_schema_transform::DEFAULT_RULE),
        CatalogRule::everywhere(&no_schema_validator_transcoding::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&require_convex_return_validator::DEFAULT_RULE),
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::everywhere(&no_unsafe_deserialize::DEFAULT_RULE),
        CatalogRule::configured_everywhere(&no_sql_string_concat::DEFAULT_RULE),
    ]
}
