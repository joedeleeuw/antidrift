pub mod no_identity_schema_transform;
pub mod no_redundant_zod_parse;
pub mod no_schema_validator_transcoding;
pub mod no_sql_string_concat;
pub mod no_unsafe_deserialize;
pub mod require_convex_return_validator;
pub mod unknown_input_must_be_decoded;
pub mod unknown_input_probe;

use serde::de::DeserializeOwned;
use tsrslint::rule::Rule;

pub(crate) fn decode_rule_options<T: DeserializeOwned + Default>(
    rule_name: &str,
    options: Option<&serde_json::Value>,
) -> Result<T, String> {
    let Some(raw) = options else {
        return Ok(T::default());
    };
    if raw.is_null() {
        return Ok(T::default());
    }
    let target = match raw.as_array() {
        Some(arr) => {
            let Some(first) = arr.first() else {
                return Ok(T::default());
            };
            if first.is_null() {
                return Ok(T::default());
            }
            first
        }
        None => raw,
    };
    serde_json::from_value::<T>(target.clone())
        .map_err(|err| format!("invalid options for {rule_name}: {err}"))
}

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &unknown_input_must_be_decoded::DEFAULT_RULE,
        &no_unsafe_deserialize::DEFAULT_RULE,
        &no_redundant_zod_parse::DEFAULT_RULE,
        &no_identity_schema_transform::DEFAULT_RULE,
        &no_schema_validator_transcoding::DEFAULT_RULE,
        &require_convex_return_validator::DEFAULT_RULE,
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
        no_unsafe_deserialize::RULE_NAME | "no-unsafe-deserialize" => {
            Ok(Some(Box::new(no_unsafe_deserialize::NoUnsafeDeserialize)))
        }
        no_redundant_zod_parse::RULE_NAME | "no-redundant-zod-parse" => {
            Ok(Some(Box::new(no_redundant_zod_parse::NoRedundantZodParse)))
        }
        no_identity_schema_transform::RULE_NAME | "no-identity-schema-transform" => Ok(Some(
            Box::new(no_identity_schema_transform::NoIdentitySchemaTransform),
        )),
        no_schema_validator_transcoding::RULE_NAME | "no-schema-validator-transcoding" => Ok(Some(
            Box::new(no_schema_validator_transcoding::NoSchemaValidatorTranscoding),
        )),
        require_convex_return_validator::RULE_NAME | "require-convex-return-validator" => {
            Ok(Some(Box::new(
                require_convex_return_validator::RequireConvexReturnValidator::from_options(
                    options,
                ),
            )))
        }
        no_sql_string_concat::RULE_NAME | "no-sql-string-concat" => Ok(Some(Box::new(
            no_sql_string_concat::NoSqlStringConcat::from_options(options)?,
        ))),
        _ => Ok(None),
    }
}
