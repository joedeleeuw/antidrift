use rustc_hash::FxHashSet;
use tsrs_ast::{
    self as ast, BinaryExpression, BindingElement, CallExpression, ConditionalExpression, Kind,
    Node, SourceFile, Symbol,
};
use tsrs_checker::Checker;
use tsrs_core::P;

use crate::{provenance, shape, tsrs_kernel};

const PRIMITIVE_COERCION_CALLEES: &[&str] = &["Boolean", "Number", "String"];

#[derive(Clone, Debug, Default)]
pub struct BagState {
    pub parameter_name: String,
    pub bag_root_symbols: FxHashSet<P<Symbol>>,
    pub bag_field_symbols: FxHashSet<P<Symbol>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BagValueCheck {
    #[default]
    Invalid,
    ValidLiteral,
    ReadsBagField,
}

impl BagValueCheck {
    #[must_use]
    pub const fn is_valid(self) -> bool {
        !matches!(self, Self::Invalid)
    }

    #[must_use]
    pub const fn reads_bag_field(self) -> bool {
        matches!(self, Self::ReadsBagField)
    }

    #[must_use]
    pub const fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Invalid, _) | (_, Self::Invalid) => Self::Invalid,
            (Self::ReadsBagField, _) | (_, Self::ReadsBagField) => Self::ReadsBagField,
            (Self::ValidLiteral, Self::ValidLiteral) => Self::ValidLiteral,
        }
    }

    #[must_use]
    pub const fn from_field_read(ok: bool) -> Self {
        if ok {
            Self::ReadsBagField
        } else {
            Self::Invalid
        }
    }
}

#[must_use]
pub fn is_nullish_expression(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if unwrapped.kind() == Kind::NullKeyword {
        return true;
    }
    if ast::is_identifier(unwrapped) && unwrapped.as_identifier().text() == "undefined" {
        return true;
    }
    if ast::is_void_expression(unwrapped) {
        let expr = tsrs_kernel::unwrap_expression(unwrapped.as_void_expression().expression());
        return ast::is_numeric_literal(expr) && expr.as_numeric_literal().text() == "0";
    }
    false
}

#[must_use]
pub fn is_static_scalar_literal(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    match unwrapped.kind() {
        Kind::StringLiteral
        | Kind::NoSubstitutionTemplateLiteral
        | Kind::NumericLiteral
        | Kind::BigIntLiteral
        | Kind::TrueKeyword
        | Kind::FalseKeyword
        | Kind::NullKeyword => true,
        Kind::Identifier => unwrapped.as_identifier().text() == "undefined",
        Kind::PrefixUnaryExpression => {
            let prefix = unwrapped.as_prefix_unary_expression();
            matches!(prefix.operator(), Kind::MinusToken | Kind::PlusToken)
                && ast::is_numeric_literal(prefix.operand())
        }
        _ => false,
    }
}

#[must_use]
pub fn is_empty_object_fallback(node: P<Node>) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    ast::is_object_literal_expression(unwrapped)
        && unwrapped
            .as_object_literal_expression()
            .properties()
            .nodes()
            .is_empty()
}

fn is_valid_binding_element_initializer(init: Option<P<Node>>) -> bool {
    init.is_none_or(|expr| is_static_scalar_literal(expr) || is_empty_object_fallback(expr))
}

fn collect_single_binding_element(
    elem: &BindingElement,
    checker: &mut Checker,
    bucket: &mut FxHashSet<P<Symbol>>,
) -> bool {
    if elem.dot_dot_dot_token().is_some()
        || !is_valid_binding_element_initializer(elem.initializer())
    {
        return false;
    }
    let Some(name_node) = elem.name() else {
        return false;
    };
    if ast::is_identifier(name_node) {
        let Some(sym) = provenance::symbol_at_node(checker, name_node) else {
            return false;
        };
        bucket.insert(sym);
        return true;
    }
    if name_node.kind() == Kind::ObjectBindingPattern {
        return collect_binding_pattern_symbols(name_node, checker, bucket);
    }
    false
}

pub fn collect_binding_pattern_symbols(
    pattern: P<Node>,
    checker: &mut Checker,
    bucket: &mut FxHashSet<P<Symbol>>,
) -> bool {
    if pattern.kind() != Kind::ObjectBindingPattern {
        return false;
    }
    let bp = pattern.as_binding_pattern();
    for &elem_node in bp.elements().nodes() {
        if !collect_single_binding_element(elem_node.as_binding_element(), checker, bucket) {
            return false;
        }
    }
    true
}

fn single_value_parameter(function_node: P<Node>) -> Option<P<Node>> {
    let mut found: Option<P<Node>> = None;
    for &param in function_node.parameters() {
        let name_node = param.as_parameter_declaration().name();
        if ast::is_identifier(name_node) && name_node.as_identifier().text() == "this" {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(param);
    }
    found
}

fn build_bag_state_from_name(
    name_node: P<Node>,
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> Option<BagState> {
    let mut root_symbols = FxHashSet::default();
    let mut field_symbols = FxHashSet::default();
    if ast::is_identifier(name_node) {
        let root_sym = provenance::symbol_at_node(checker, name_node)?;
        root_symbols.insert(root_sym);
        return Some(BagState {
            parameter_name: name_node.as_identifier().text().to_string(),
            bag_root_symbols: root_symbols,
            bag_field_symbols: field_symbols,
        });
    }
    if name_node.kind() == Kind::ObjectBindingPattern {
        if !collect_binding_pattern_symbols(name_node, checker, &mut field_symbols)
            || field_symbols.is_empty()
        {
            return None;
        }
        let raw_text = tsrs_kernel::node_text(sf, name_node)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return Some(BagState {
            parameter_name: raw_text,
            bag_root_symbols: root_symbols,
            bag_field_symbols: field_symbols,
        });
    }
    None
}

pub fn resolve_bag_parameter(
    function_node: P<Node>,
    checker: &mut Checker,
    sf: P<SourceFile>,
) -> Option<BagState> {
    let param_node = single_value_parameter(function_node)?;
    let param = param_node.as_parameter_declaration();
    let name_node = param.name();
    if param.dot_dot_dot_token().is_some() || name_node.kind() == Kind::ArrayBindingPattern {
        return None;
    }
    if let Some(init) = param.initializer()
        && !is_empty_object_fallback(init)
        && !is_nullish_expression(init)
    {
        return None;
    }
    let param_type = checker.get_type_at_location(param_node);
    if !shape::is_plain_bag_type(checker, param_type) {
        return None;
    }
    build_bag_state_from_name(name_node, checker, sf)
}

fn has_bag_symbol(bag_state: &BagState, sym: Option<P<Symbol>>) -> bool {
    let Some(symbol) = sym else {
        return false;
    };
    bag_state.bag_root_symbols.contains(&symbol) || bag_state.bag_field_symbols.contains(&symbol)
}

pub fn is_bag_member_chain(node: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    let receiver = match unwrapped.kind() {
        Kind::PropertyAccessExpression => {
            let prop = unwrapped.as_property_access_expression();
            let Some(prop_name) = tsrs_kernel::property_name_text(prop.name()) else {
                return false;
            };
            if prop_name == "length" || prop_name == "size" {
                return false;
            }
            tsrs_kernel::unwrap_expression(prop.expression())
        }
        Kind::ElementAccessExpression => {
            let elem = unwrapped.as_element_access_expression();
            if !is_static_scalar_literal(elem.argument_expression()) {
                return false;
            }
            tsrs_kernel::unwrap_expression(elem.expression())
        }
        _ => return false,
    };
    if ast::is_identifier(receiver) {
        return has_bag_symbol(bag_state, provenance::symbol_at_node(checker, receiver));
    }
    is_bag_member_chain(receiver, bag_state, checker)
}

pub fn is_bag_object_reference(node: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if ast::is_identifier(unwrapped) {
        return has_bag_symbol(bag_state, provenance::symbol_at_node(checker, unwrapped));
    }
    if ast::is_binary_expression(unwrapped) {
        let bin = unwrapped.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::QuestionQuestionToken | Kind::BarBarToken
        ) && is_empty_object_fallback(bin.right())
        {
            return is_bag_object_reference(bin.left(), bag_state, checker);
        }
    }
    is_bag_member_chain(unwrapped, bag_state, checker)
}

fn is_pure_binary_bag_condition(
    bin: &BinaryExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> bool {
    if !matches!(
        bin.operator_token().kind(),
        Kind::AmpersandAmpersandToken
            | Kind::BarBarToken
            | Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken
    ) {
        return false;
    }
    let left_ok = is_pure_bag_condition(bin.left(), bag_state, checker)
        || is_bag_object_reference(bin.left(), bag_state, checker);
    let right_ok = is_pure_bag_condition(bin.right(), bag_state, checker)
        || is_bag_object_reference(bin.right(), bag_state, checker);
    left_ok && right_ok
}

pub fn is_pure_bag_condition(node: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if inspect_bag_value_expression(unwrapped, bag_state, checker).is_valid() {
        return true;
    }
    if ast::is_prefix_unary_expression(unwrapped) {
        let prefix = unwrapped.as_prefix_unary_expression();
        if prefix.operator() == Kind::ExclamationToken {
            return is_pure_bag_condition(prefix.operand(), bag_state, checker);
        }
    }
    if unwrapped.kind() == Kind::TypeOfExpression {
        let expr = unwrapped.as_type_of_expression().expression();
        return is_bag_object_reference(expr, bag_state, checker)
            || inspect_bag_value_expression(expr, bag_state, checker).is_valid();
    }
    if ast::is_binary_expression(unwrapped) {
        return is_pure_binary_bag_condition(unwrapped.as_binary_expression(), bag_state, checker);
    }
    false
}

fn inspect_binary_bag_value(
    bin: &BinaryExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> BagValueCheck {
    if matches!(
        bin.operator_token().kind(),
        Kind::QuestionQuestionToken | Kind::BarBarToken | Kind::AmpersandAmpersandToken
    ) {
        let left = inspect_bag_value_expression(bin.left(), bag_state, checker);
        let right = inspect_bag_value_expression(bin.right(), bag_state, checker);
        return left.combine(right);
    }
    BagValueCheck::Invalid
}

fn inspect_conditional_bag_value(
    cond: &ConditionalExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> BagValueCheck {
    if !is_pure_bag_condition(cond.condition(), bag_state, checker) {
        return BagValueCheck::Invalid;
    }
    let when_true = inspect_bag_value_expression(cond.when_true(), bag_state, checker);
    let when_false = inspect_bag_value_expression(cond.when_false(), bag_state, checker);
    when_true.combine(when_false)
}

fn inspect_call_bag_value(
    call: &CallExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> BagValueCheck {
    let callee = call.expression();
    let args = call.arguments().nodes();
    if !ast::is_identifier(callee) || args.len() != 1 {
        return BagValueCheck::Invalid;
    }
    if !PRIMITIVE_COERCION_CALLEES.contains(&callee.as_identifier().text()) {
        return BagValueCheck::Invalid;
    }
    let arg_check = inspect_bag_value_expression(args[0], bag_state, checker);
    BagValueCheck::from_field_read(arg_check.reads_bag_field())
}

pub fn inspect_bag_value_expression(
    node: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
) -> BagValueCheck {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if is_static_scalar_literal(unwrapped) {
        return BagValueCheck::ValidLiteral;
    }
    if ast::is_identifier(unwrapped) {
        if let Some(sym) = provenance::symbol_at_node(checker, unwrapped)
            && bag_state.bag_field_symbols.contains(&sym)
        {
            return BagValueCheck::ReadsBagField;
        }
        return BagValueCheck::Invalid;
    }
    if is_bag_member_chain(unwrapped, bag_state, checker) {
        return BagValueCheck::ReadsBagField;
    }
    match unwrapped.kind() {
        Kind::PrefixUnaryExpression => {
            let prefix = unwrapped.as_prefix_unary_expression();
            if prefix.operator() == Kind::ExclamationToken {
                return inspect_bag_value_expression(prefix.operand(), bag_state, checker);
            }
            BagValueCheck::Invalid
        }
        Kind::BinaryExpression => {
            inspect_binary_bag_value(unwrapped.as_binary_expression(), bag_state, checker)
        }
        Kind::ConditionalExpression => {
            inspect_conditional_bag_value(unwrapped.as_conditional_expression(), bag_state, checker)
        }
        Kind::CallExpression => {
            inspect_call_bag_value(unwrapped.as_call_expression(), bag_state, checker)
        }
        Kind::ObjectLiteralExpression => BagValueCheck::from_field_read(
            inspect_object_literal_bag_projection(unwrapped, bag_state, checker),
        ),
        _ => BagValueCheck::Invalid,
    }
}

fn inspect_object_literal_property(
    prop_node: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
) -> BagValueCheck {
    match prop_node.kind() {
        Kind::SpreadAssignment => BagValueCheck::from_field_read(is_bag_object_reference(
            prop_node.as_spread_assignment().expression(),
            bag_state,
            checker,
        )),
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
            BagValueCheck::from_field_read(bag_state.bag_field_symbols.contains(&sym))
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

pub fn inspect_object_literal_bag_projection(
    object_literal: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
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
    for &prop_node in props {
        let check = inspect_object_literal_property(prop_node, bag_state, checker);
        if !check.is_valid() {
            return false;
        }
        if check.reads_bag_field() {
            bag_field_read_count += 1;
        }
    }
    bag_field_read_count >= 1
}
