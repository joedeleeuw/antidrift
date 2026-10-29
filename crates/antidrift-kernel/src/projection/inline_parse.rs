use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, ConditionalExpression, Kind, Node, Symbol};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::projection::bag_state::{
    BagState, inspect_bag_value_expression, inspect_object_literal_bag_projection,
    is_bag_object_reference, is_pure_bag_condition, is_static_scalar_literal,
};
use crate::{provenance, tsrs_kernel};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlineParseReshapeKind {
    Object,
    Conditional,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineParseReshapeClassification {
    pub kind: InlineParseReshapeKind,
    pub source: String,
}

struct RootSource {
    symbol: P<Symbol>,
    name: String,
}

fn static_member_or_element_base(node: P<Node>) -> Option<P<Node>> {
    match node.kind() {
        Kind::PropertyAccessExpression => Some(node.as_property_access_expression().expression()),
        Kind::ElementAccessExpression => {
            let elem = node.as_element_access_expression();
            if is_static_scalar_literal(elem.argument_expression()) {
                Some(elem.expression())
            } else {
                None
            }
        }
        _ => None,
    }
}

fn root_source_from_member_chain(unwrapped: P<Node>, checker: &mut Checker) -> Option<RootSource> {
    let first_base = static_member_or_element_base(unwrapped)?;
    let mut base = tsrs_kernel::unwrap_expression(first_base);
    while let Some(next_base) = static_member_or_element_base(base) {
        base = tsrs_kernel::unwrap_expression(next_base);
    }
    if ast::is_identifier(base)
        && let Some(sym) = provenance::symbol_at_node(checker, base)
    {
        return Some(RootSource {
            symbol: sym,
            name: base.as_identifier().text().to_owned(),
        });
    }
    None
}

fn find_single_root_source(expr: P<Node>, checker: &mut Checker) -> Option<RootSource> {
    let unwrapped = tsrs_kernel::unwrap_expression(expr);
    match unwrapped.kind() {
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression => {
            return root_source_from_member_chain(unwrapped, checker);
        }
        Kind::SpreadAssignment => {
            let target =
                tsrs_kernel::unwrap_expression(unwrapped.as_spread_assignment().expression());
            if ast::is_identifier(target)
                && let Some(sym) = provenance::symbol_at_node(checker, target)
            {
                return Some(RootSource {
                    symbol: sym,
                    name: target.as_identifier().text().to_owned(),
                });
            }
            return find_single_root_source(target, checker);
        }
        _ => {}
    }
    let mut discovered: Option<RootSource> = None;
    unwrapped.for_each_child(&mut |child| {
        if discovered.is_none() {
            discovered = find_single_root_source(child, checker);
        }
        discovered.is_some()
    });
    discovered
}

fn is_inline_reshape_branch(branch: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(branch);
    if is_bag_object_reference(unwrapped, bag_state, checker) {
        return true;
    }
    if !ast::is_object_literal_expression(unwrapped) {
        return false;
    }
    let props = unwrapped
        .as_object_literal_expression()
        .properties()
        .nodes();
    if props.is_empty() {
        return false;
    }
    for &prop in props {
        let valid = match prop.kind() {
            Kind::SpreadAssignment => is_bag_object_reference(
                prop.as_spread_assignment().expression(),
                bag_state,
                checker,
            ),
            Kind::PropertyAssignment => inspect_bag_value_expression(
                prop.as_property_assignment().initializer(),
                bag_state,
                checker,
            )
            .is_valid(),
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}

fn is_combinator_call_parent(parent: Option<P<Node>>) -> bool {
    let Some(parent_node) = parent else {
        return false;
    };
    if !ast::is_call_expression(parent_node) {
        return false;
    }
    let callee = parent_node.as_call_expression().expression();
    if !ast::is_property_access_expression(callee) {
        return false;
    }
    let Some(name) = tsrs_kernel::property_name_text(callee.as_property_access_expression().name())
    else {
        return false;
    };
    name == "preprocess" || name == "transform"
}

fn is_inside_combinator_callback(node: P<Node>) -> bool {
    let mut current = node.parent();
    while let Some(curr) = current {
        if matches!(curr.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
            return is_combinator_call_parent(curr.parent());
        }
        current = curr.parent();
    }
    false
}

fn is_conditional_inline_reshape(
    cond: &ConditionalExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> bool {
    let when_true = tsrs_kernel::unwrap_expression(cond.when_true());
    let when_false = tsrs_kernel::unwrap_expression(cond.when_false());
    is_pure_bag_condition(cond.condition(), bag_state, checker)
        && is_inline_reshape_branch(cond.when_true(), bag_state, checker)
        && is_inline_reshape_branch(cond.when_false(), bag_state, checker)
        && (ast::is_object_literal_expression(when_true)
            || ast::is_object_literal_expression(when_false))
}

pub fn classify_inline_parse_reshape(
    arg_node: P<Node>,
    checker: &mut Checker,
) -> Option<InlineParseReshapeClassification> {
    if is_inside_combinator_callback(arg_node) {
        return None;
    }
    let raw_arg = tsrs_kernel::unwrap_expression(arg_node);
    let root = find_single_root_source(raw_arg, checker)?;
    let mut root_symbols = FxHashSet::default();
    root_symbols.insert(root.symbol);
    let bag_state = BagState {
        parameter_name: String::new(),
        parameter_node: None,
        root_symbols,
        field_symbols: FxHashSet::default(),
    };
    if ast::is_object_literal_expression(raw_arg)
        && inspect_object_literal_bag_projection(raw_arg, &bag_state, checker)
    {
        return Some(InlineParseReshapeClassification {
            kind: InlineParseReshapeKind::Object,
            source: root.name,
        });
    }
    if ast::is_conditional_expression(raw_arg)
        && is_conditional_inline_reshape(raw_arg.as_conditional_expression(), &bag_state, checker)
    {
        return Some(InlineParseReshapeClassification {
            kind: InlineParseReshapeKind::Conditional,
            source: root.name,
        });
    }
    None
}
