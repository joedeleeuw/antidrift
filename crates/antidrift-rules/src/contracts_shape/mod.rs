pub mod no_contract_appeasement_projection;
pub mod no_explicit_type_arguments_on_owned_api;
pub mod no_nullable_positional_tuple;
pub mod no_service_constructor_imports;
pub mod no_structural_type_fork;
pub mod react_max_component_props;
pub mod structural_fork_analysis;

use tsrslint::rule::Rule;

#[must_use]
pub fn rules() -> Vec<&'static dyn Rule> {
    vec![
        &no_contract_appeasement_projection::RULE,
        &no_structural_type_fork::RULE,
        &no_nullable_positional_tuple::RULE,
        &react_max_component_props::RULE,
        &no_explicit_type_arguments_on_owned_api::RULE,
        &no_service_constructor_imports::RULE,
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        "antidrift/no-contract-appeasement-projection" | "no-contract-appeasement-projection" => {
            Ok(Some(Box::new(
                no_contract_appeasement_projection::NoContractAppeasementProjection,
            )))
        }
        "antidrift/no-structural-type-fork" | "no-structural-type-fork" => Ok(Some(Box::new(
            no_structural_type_fork::NoStructuralTypeFork::from_options(options)?,
        ))),
        "antidrift/no-nullable-positional-tuple" | "no-nullable-positional-tuple" => Ok(Some(
            Box::new(no_nullable_positional_tuple::NoNullablePositionalTuple),
        )),
        "antidrift/react-max-component-props" | "react-max-component-props" => Ok(Some(Box::new(
            react_max_component_props::ReactMaxComponentProps::from_options(options)?,
        ))),
        "antidrift/no-explicit-type-arguments-on-owned-api"
        | "no-explicit-type-arguments-on-owned-api" => Ok(Some(Box::new(
            no_explicit_type_arguments_on_owned_api::NoExplicitTypeArgumentsOnOwnedApi,
        ))),
        "antidrift/no-service-constructor-imports" | "no-service-constructor-imports" => Ok(Some(
            Box::new(no_service_constructor_imports::NoServiceConstructorImports),
        )),
        _ => Ok(None),
    }
}
