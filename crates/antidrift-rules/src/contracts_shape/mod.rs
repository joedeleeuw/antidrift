pub mod no_contract_appeasement_projection;
pub mod no_explicit_type_arguments_on_owned_api;
pub mod no_hypothetical_seam;
pub mod no_nullable_positional_tuple;
pub mod no_service_constructor_imports;
pub mod no_structural_type_fork;
pub mod react_max_component_props;
pub mod redundant_local_return;
mod redundant_owner_prefix;
pub mod structural_fork_analysis;
mod test_only_seam;

use crate::CatalogRule;
use antidrift_kernel::scope_policy::ScopePolicy;
use tsrslint::rule::Rule;

#[must_use]
pub fn rules() -> Vec<CatalogRule> {
    vec![
        CatalogRule::new(
            &no_contract_appeasement_projection::RULE,
            ScopePolicy::ExceptGenerated,
        ),
        CatalogRule::everywhere(&no_structural_type_fork::RULE),
        CatalogRule::everywhere(&no_nullable_positional_tuple::RULE),
        CatalogRule::everywhere(&react_max_component_props::RULE),
        CatalogRule::everywhere(&no_explicit_type_arguments_on_owned_api::RULE),
        CatalogRule::everywhere(&no_service_constructor_imports::RULE),
        CatalogRule::new(
            &no_hypothetical_seam::DEFAULT_RULE,
            ScopePolicy::AuthoredSource,
        ),
    ]
}

pub fn create_rule(
    name: &str,
    options: Option<&serde_json::Value>,
) -> Result<Option<Box<dyn Rule>>, String> {
    match name {
        "antidrift/no-contract-appeasement-projection" | "no-contract-appeasement-projection" => {
            Ok(Some(Box::new(
                no_contract_appeasement_projection::NoContractAppeasementProjection::from_options(
                    options,
                )?,
            )))
        }
        "antidrift/no-structural-type-fork" | "no-structural-type-fork" => Ok(Some(Box::new(
            no_structural_type_fork::NoStructuralTypeFork::from_options(options)?,
        ))),
        "antidrift/no-nullable-positional-tuple" | "no-nullable-positional-tuple" => Ok(Some(
            Box::new(no_nullable_positional_tuple::NoNullablePositionalTuple::from_options(
                options,
            )?),
        )),
        "antidrift/react-max-component-props" | "react-max-component-props" => Ok(Some(Box::new(
            react_max_component_props::ReactMaxComponentProps::from_options(options)?,
        ))),
        "antidrift/no-explicit-type-arguments-on-owned-api"
        | "no-explicit-type-arguments-on-owned-api" => Ok(Some(Box::new(
            no_explicit_type_arguments_on_owned_api::NoExplicitTypeArgumentsOnOwnedApi::from_options(
                options,
            )?,
        ))),
        "antidrift/no-service-constructor-imports" | "no-service-constructor-imports" => Ok(Some(
            Box::new(no_service_constructor_imports::NoServiceConstructorImports::from_options(
                options,
            )?),
        )),
        no_hypothetical_seam::RULE_NAME | "no-hypothetical-seam" => Ok(Some(Box::new(
            no_hypothetical_seam::NoHypotheticalSeam::from_options(options)?,
        ))),
        _ => Ok(None),
    }
}
