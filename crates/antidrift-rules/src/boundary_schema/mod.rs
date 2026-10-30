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

use antidrift_kernel::rule_scope::decode_rule_options;
use tsrslint::rule::Rule;

#[must_use]
pub fn typescript_only_rules() -> Vec<&'static dyn Rule> {
    vec![
        &unknown_input_must_be_decoded::DEFAULT_RULE,
        &no_external_decode_in_tsx::DEFAULT_RULE,
        &no_redundant_zod_parse::DEFAULT_RULE,
        &no_identity_schema_transform::DEFAULT_RULE,
        &no_schema_validator_transcoding::DEFAULT_RULE,
        &require_convex_return_validator::DEFAULT_RULE,
    ]
}

#[must_use]
pub fn script_default_rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_unsafe_deserialize::DEFAULT_RULE,
        &no_sql_string_concat::DEFAULT_RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        unknown_input_must_be_decoded::RULE_NAME | "unknown-input-must-be-decoded" => {
            Ok(Some(Box::new(
                unknown_input_must_be_decoded::UnknownInputMustBeDecoded::from_options(options)?,
            )))
        }
        no_external_decode_in_tsx::RULE_NAME | "no-external-decode-in-tsx" => Ok(Some(Box::new(
            no_external_decode_in_tsx::NoExternalDecodeInTsx::from_options(options)?,
        ))),
        no_unsafe_deserialize::RULE_NAME | "no-unsafe-deserialize" => Ok(Some(Box::new(
            no_unsafe_deserialize::NoUnsafeDeserialize::from_options(options)?,
        ))),
        no_redundant_zod_parse::RULE_NAME | "no-redundant-zod-parse" => Ok(Some(Box::new(
            no_redundant_zod_parse::NoRedundantZodParse::from_options(options)?,
        ))),
        no_identity_schema_transform::RULE_NAME | "no-identity-schema-transform" => {
            Ok(Some(Box::new(
                no_identity_schema_transform::NoIdentitySchemaTransform::from_options(options)?,
            )))
        }
        no_schema_validator_transcoding::RULE_NAME | "no-schema-validator-transcoding" => {
            Ok(Some(Box::new(
                no_schema_validator_transcoding::NoSchemaValidatorTranscoding::from_options(
                    options,
                )?,
            )))
        }
        require_convex_return_validator::RULE_NAME | "require-convex-return-validator" => {
            Ok(Some(Box::new(
                require_convex_return_validator::RequireConvexReturnValidator::from_options(
                    options,
                )?,
            )))
        }
        no_sql_string_concat::RULE_NAME | "no-sql-string-concat" => Ok(Some(Box::new(
            no_sql_string_concat::NoSqlStringConcat::from_options(options)?,
        ))),
        _ => Ok(None),
    }
}
