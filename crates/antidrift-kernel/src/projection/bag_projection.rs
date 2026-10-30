use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::projection::bag_state::{
    BagState, BagValueCheck, inspect_bag_value_expression, is_bag_object_reference,
    is_static_scalar_literal,
};
use crate::{provenance, tsrs_kernel};

#[derive(Clone, Copy, Debug, Default)]
pub struct BagProjectionOptions {
    pub whole_root_reference_is_envelope: bool,
    pub allow_static_branch: bool,
}

fn is_whole_root_reference(node: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    ast::is_identifier(unwrapped)
        && provenance::symbol_at_node(checker, unwrapped)
            .is_some_and(|sym| bag_state.root_symbols.contains(&sym))
}

fn inspect_object_literal_property(
    prop_node: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
    whole_root_reference_is_envelope: bool,
) -> BagValueCheck {
    match prop_node.kind() {
        Kind::SpreadAssignment => {
            let expr = prop_node.as_spread_assignment().expression();
            if !is_bag_object_reference(expr, bag_state, checker) {
                return BagValueCheck::Invalid;
            }
            if whole_root_reference_is_envelope && is_whole_root_reference(expr, bag_state, checker)
            {
                BagValueCheck::ValidLiteral
            } else {
                BagValueCheck::ReadsBagField
            }
        }
        Kind::ShorthandPropertyAssignment => {
            let shorthand = prop_node.as_shorthand_property_assignment();
            if let Some(init) = shorthand.object_assignment_initializer()
                && !is_static_scalar_literal(init)
            {
                return BagValueCheck::Invalid;
            }
            let Some(sym) = provenance::symbol_at_node(checker, shorthand.name()) else {
                return BagValueCheck::Invalid;
            };
            if bag_state.field_symbols.contains(&sym) {
                BagValueCheck::ReadsBagField
            } else if whole_root_reference_is_envelope && bag_state.root_symbols.contains(&sym) {
                BagValueCheck::ValidLiteral
            } else {
                BagValueCheck::Invalid
            }
        }
        Kind::PropertyAssignment => {
            let pa = prop_node.as_property_assignment();
            let name_node = pa.name();
            if name_node.kind() == Kind::ComputedPropertyName
                && !is_static_scalar_literal(name_node.as_computed_property_name().expression())
            {
                return BagValueCheck::Invalid;
            }
            inspect_bag_value_expression(pa.initializer(), bag_state, checker)
        }
        _ => BagValueCheck::Invalid,
    }
}

pub fn inspect_object_literal_bag_projection_with_options(
    object_literal: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
    options: BagProjectionOptions,
) -> bool {
    if !ast::is_object_literal_expression(object_literal) {
        return false;
    }
    let props = object_literal
        .as_object_literal_expression()
        .properties()
        .nodes();
    if props.is_empty() {
        return false;
    }
    let mut bag_field_read_count = 0usize;
    let mut has_whole_root_envelope = false;
    for &prop_node in props {
        let check = inspect_object_literal_property(
            prop_node,
            bag_state,
            checker,
            options.whole_root_reference_is_envelope,
        );
        if !check.is_valid() {
            return false;
        }
        if matches!(
            prop_node.kind(),
            Kind::SpreadAssignment | Kind::ShorthandPropertyAssignment
        ) && check == BagValueCheck::ValidLiteral
        {
            has_whole_root_envelope = true;
        }
        if check.reads_bag_field() {
            bag_field_read_count += 1;
        }
    }
    bag_field_read_count >= 1 || (options.allow_static_branch && !has_whole_root_envelope)
}

pub fn inspect_object_literal_bag_projection(
    object_literal: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
) -> bool {
    inspect_object_literal_bag_projection_with_options(
        object_literal,
        bag_state,
        checker,
        BagProjectionOptions::default(),
    )
}
