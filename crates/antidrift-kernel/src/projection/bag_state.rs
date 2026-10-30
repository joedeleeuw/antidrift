use rustc_hash::FxHashSet;
use tsrs_ast::{
    self as ast, BinaryExpression, CallExpression, ConditionalExpression, Kind, Node, Symbol,
};
use tsrs_checker::Checker;
use tsrs_core::P;
use tsrslint::utils::find_modifier;

use crate::projection::bag_projection::inspect_object_literal_bag_projection;
use crate::{provenance, tsrs_kernel};

const PRIMITIVE_COERCION_CALLEES: &[&str] = &["Boolean", "Number", "String"];

#[derive(Clone, Debug, Default)]
pub struct BagState {
    pub parameter_name: String,
    pub parameter_node: Option<P<Node>>,
    pub root_symbols: FxHashSet<P<Symbol>>,
    pub field_symbols: FxHashSet<P<Symbol>>,
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

fn has_bag_symbol(bag_state: &BagState, sym: Option<P<Symbol>>) -> bool {
    sym.is_some_and(|symbol| {
        bag_state.root_symbols.contains(&symbol) || bag_state.field_symbols.contains(&symbol)
    })
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

fn is_valid_comparison_operand(
    node: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
) -> (bool, bool) {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if unwrapped.kind() == Kind::PropertyAccessExpression {
        let prop = unwrapped.as_property_access_expression();
        if tsrs_kernel::property_name_text(prop.name())
            .is_some_and(|name| name == "length" || name == "size")
            && is_bag_object_reference(prop.expression(), bag_state, checker)
        {
            return (true, true);
        }
    }
    if ast::is_binary_expression(unwrapped) {
        let bin = unwrapped.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::QuestionQuestionToken | Kind::BarBarToken | Kind::AmpersandAmpersandToken
        ) {
            let (lv, lr) = is_valid_comparison_operand(bin.left(), bag_state, checker);
            let (rv, rr) = is_valid_comparison_operand(bin.right(), bag_state, checker);
            return (lv && rv, lr || rr);
        }
    }
    if is_pure_bag_condition(unwrapped, bag_state, checker)
        || is_bag_object_reference(unwrapped, bag_state, checker)
    {
        return (true, true);
    }
    let check = inspect_bag_value_expression(unwrapped, bag_state, checker);
    (check.is_valid(), check.reads_bag_field())
}

fn is_pure_binary_bag_condition(
    bin: &BinaryExpression,
    bag_state: &BagState,
    checker: &mut Checker,
) -> bool {
    let op = bin.operator_token().kind();
    if matches!(op, Kind::AmpersandAmpersandToken | Kind::BarBarToken) {
        let left_ok = is_pure_bag_condition(bin.left(), bag_state, checker)
            || is_bag_object_reference(bin.left(), bag_state, checker);
        let right_ok = is_pure_bag_condition(bin.right(), bag_state, checker)
            || is_bag_object_reference(bin.right(), bag_state, checker);
        return left_ok && right_ok;
    }
    if matches!(
        op,
        Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsEqualsToken
            | Kind::EqualsEqualsToken
            | Kind::ExclamationEqualsToken
            | Kind::GreaterThanToken
            | Kind::GreaterThanEqualsToken
            | Kind::LessThanToken
            | Kind::LessThanEqualsToken
    ) {
        let (left_valid, left_reads) = is_valid_comparison_operand(bin.left(), bag_state, checker);
        let (right_valid, right_reads) =
            is_valid_comparison_operand(bin.right(), bag_state, checker);
        return left_valid && right_valid && (left_reads || right_reads);
    }
    false
}

pub fn is_pure_bag_condition(node: P<Node>, bag_state: &BagState, checker: &mut Checker) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(node);
    if inspect_bag_value_expression(unwrapped, bag_state, checker).reads_bag_field() {
        return true;
    }
    if ast::is_prefix_unary_expression(unwrapped) {
        let prefix = unwrapped.as_prefix_unary_expression();
        if prefix.operator() == Kind::ExclamationToken {
            return is_pure_bag_condition(prefix.operand(), bag_state, checker)
                || is_bag_object_reference(prefix.operand(), bag_state, checker);
        }
    }
    if unwrapped.kind() == Kind::TypeOfExpression {
        let expr = unwrapped.as_type_of_expression().expression();
        return is_bag_object_reference(expr, bag_state, checker)
            || inspect_bag_value_expression(expr, bag_state, checker).reads_bag_field();
    }
    if ast::is_binary_expression(unwrapped) {
        return is_pure_binary_bag_condition(unwrapped.as_binary_expression(), bag_state, checker);
    }
    false
}

fn extract_thunk_call_expression(fn_node: P<Node>) -> Option<P<Node>> {
    let body = tsrs_kernel::function_body_node(fn_node)?;
    let expr = if ast::is_block(body) {
        let stmts = body.as_block().statements().nodes();
        if stmts.len() != 1 {
            return None;
        }
        match stmts[0].kind() {
            Kind::ReturnStatement => stmts[0].as_return_statement().expression()?,
            Kind::ExpressionStatement => stmts[0].as_expression_statement().expression(),
            _ => return None,
        }
    } else {
        body
    };
    let unwrapped = tsrs_kernel::unwrap_expression(expr);
    let inner = if ast::is_void_expression(unwrapped) {
        tsrs_kernel::unwrap_expression(unwrapped.as_void_expression().expression())
    } else {
        unwrapped
    };
    (inner.kind() == Kind::CallExpression).then_some(inner)
}

fn is_zero_arg_bag_callback_thunk(
    fn_node: P<Node>,
    bag_state: &BagState,
    checker: &mut Checker,
) -> bool {
    if !matches!(
        fn_node.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) || tsrs_kernel::is_generator_function(fn_node)
        || find_modifier(fn_node, Kind::AsyncKeyword).is_some()
        || !fn_node.parameters().is_empty()
    {
        return false;
    }
    let Some(call_node) = extract_thunk_call_expression(fn_node) else {
        return false;
    };
    let call = call_node.as_call_expression();
    if !call.arguments().nodes().is_empty() {
        return false;
    }
    let callee = tsrs_kernel::unwrap_expression(call.expression());
    if ast::is_identifier(callee) {
        return provenance::symbol_at_node(checker, callee)
            .is_some_and(|sym| bag_state.field_symbols.contains(&sym));
    }
    is_bag_member_chain(callee, bag_state, checker)
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
            && bag_state.field_symbols.contains(&sym)
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
        Kind::ArrowFunction | Kind::FunctionExpression => BagValueCheck::from_field_read(
            is_zero_arg_bag_callback_thunk(unwrapped, bag_state, checker),
        ),
        Kind::ObjectLiteralExpression => BagValueCheck::from_field_read(
            inspect_object_literal_bag_projection(unwrapped, bag_state, checker),
        ),
        _ => BagValueCheck::Invalid,
    }
}
