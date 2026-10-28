pub mod no_bag_reshaper;
pub mod no_contract_appeasement_projection;
pub mod no_explicit_type_arguments_on_owned_api;
pub mod no_nullable_positional_tuple;
pub mod no_service_constructor_imports;
pub mod no_structural_type_fork;
pub mod react_max_component_props;
pub mod structural_type_fork_helpers;

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

#[must_use]
pub fn create_rule(name: &str, options: Option<&serde_json::Value>) -> Option<Box<dyn Rule>> {
    match name {
        "antidrift/no-contract-appeasement-projection" | "no-contract-appeasement-projection" => {
            Some(Box::new(
                no_contract_appeasement_projection::NoContractAppeasementProjection,
            ))
        }
        "antidrift/no-bag-reshaper" | "no-bag-reshaper" => {
            Some(Box::new(no_bag_reshaper::NoBagReshaper))
        }
        "antidrift/no-structural-type-fork" | "no-structural-type-fork" => Some(Box::new(
            no_structural_type_fork::NoStructuralTypeFork::from_options(options),
        )),
        "antidrift/no-nullable-positional-tuple" | "no-nullable-positional-tuple" => Some(
            Box::new(no_nullable_positional_tuple::NoNullablePositionalTuple),
        ),
        "antidrift/react-max-component-props" | "react-max-component-props" => Some(Box::new(
            react_max_component_props::ReactMaxComponentProps::from_options(options),
        )),
        "antidrift/no-explicit-type-arguments-on-owned-api"
        | "no-explicit-type-arguments-on-owned-api" => Some(Box::new(
            no_explicit_type_arguments_on_owned_api::NoExplicitTypeArgumentsOnOwnedApi,
        )),
        "antidrift/no-service-constructor-imports" | "no-service-constructor-imports" => Some(
            Box::new(no_service_constructor_imports::NoServiceConstructorImports),
        ),
        _ => None,
    }
}
