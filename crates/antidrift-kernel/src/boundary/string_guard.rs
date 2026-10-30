use crate::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, BinaryExpression, Kind, Node};
use tsrs_core::P;

use crate::tsrs_kernel;

fn same_simple_expr(left: P<Node>, right: P<Node>) -> bool {
    let left_node = tsrs_kernel::unwrap_expression(left);
    let right_node = tsrs_kernel::unwrap_expression(right);
    if left_node.kind() != right_node.kind() {
        return false;
    }
    match left_node.kind() {
        Kind::Identifier => left_node.as_identifier().text() == right_node.as_identifier().text(),
        Kind::ThisKeyword | Kind::SuperKeyword => true,
        Kind::StringLiteral | Kind::NumericLiteral | Kind::NoSubstitutionTemplateLiteral => {
            cooked_text(left_node).is_some_and(|left| cooked_text(right_node) == Some(left))
        }
        Kind::PropertyAccessExpression => {
            let left_pa = left_node.as_property_access_expression();
            let right_pa = right_node.as_property_access_expression();
            let Some(left_name) = tsrs_kernel::property_name_text(left_pa.name()) else {
                return false;
            };
            let Some(right_name) = tsrs_kernel::property_name_text(right_pa.name()) else {
                return false;
            };
            left_name == right_name && same_simple_expr(left_pa.expression(), right_pa.expression())
        }
        Kind::ElementAccessExpression => {
            let left_ea = left_node.as_element_access_expression();
            let right_ea = right_node.as_element_access_expression();
            same_simple_expr(left_ea.expression(), right_ea.expression())
                && same_simple_expr(
                    left_ea.argument_expression(),
                    right_ea.argument_expression(),
                )
        }
        _ => false,
    }
}

fn typeof_string_operand(left: P<Node>, right: P<Node>) -> Option<P<Node>> {
    if left.kind() == Kind::TypeOfExpression
        && ast::is_string_literal(right)
        && cooked_text(right) == Some("string")
    {
        return Some(left.as_type_of_expression().expression());
    }
    if right.kind() == Kind::TypeOfExpression
        && ast::is_string_literal(left)
        && cooked_text(left) == Some("string")
    {
        return Some(right.as_type_of_expression().expression());
    }
    None
}

fn string_typeof_guard(cond: P<Node>, expr: P<Node>) -> Option<(bool, bool)> {
    let unwrapped = tsrs_kernel::unwrap_expression(cond);
    if !ast::is_binary_expression(unwrapped) {
        return None;
    }
    let bin = unwrapped.as_binary_expression();
    let op = bin.operator_token().kind();
    if !matches!(
        op,
        Kind::EqualsEqualsToken
            | Kind::EqualsEqualsEqualsToken
            | Kind::ExclamationEqualsToken
            | Kind::ExclamationEqualsEqualsToken
    ) {
        return None;
    }
    let left = tsrs_kernel::unwrap_expression(bin.left());
    let right = tsrs_kernel::unwrap_expression(bin.right());
    let operand = typeof_string_operand(left, right)?;
    if !same_simple_expr(operand, expr) {
        return None;
    }
    let is_eq = matches!(op, Kind::EqualsEqualsToken | Kind::EqualsEqualsEqualsToken);
    Some((is_eq, !is_eq))
}

fn binary_condition_ensures_string(
    bin: &BinaryExpression,
    expr: P<Node>,
    when_truthy: bool,
) -> bool {
    match bin.operator_token().kind() {
        Kind::AmpersandAmpersandToken => {
            if when_truthy {
                condition_ensures_string(bin.left(), expr, true)
                    || condition_ensures_string(bin.right(), expr, true)
            } else {
                condition_ensures_string(bin.left(), expr, false)
                    && condition_ensures_string(bin.right(), expr, false)
            }
        }
        Kind::BarBarToken => {
            if when_truthy {
                condition_ensures_string(bin.left(), expr, true)
                    && condition_ensures_string(bin.right(), expr, true)
            } else {
                condition_ensures_string(bin.left(), expr, false)
                    || condition_ensures_string(bin.right(), expr, false)
            }
        }
        _ => false,
    }
}

fn condition_ensures_string(cond: P<Node>, expr: P<Node>, when_truthy: bool) -> bool {
    let unwrapped = tsrs_kernel::unwrap_expression(cond);
    if let Some((truthy, falsy)) = string_typeof_guard(unwrapped, expr) {
        return if when_truthy { truthy } else { falsy };
    }
    if ast::is_prefix_unary_expression(unwrapped)
        && unwrapped.as_prefix_unary_expression().operator() == Kind::ExclamationToken
    {
        return condition_ensures_string(
            unwrapped.as_prefix_unary_expression().operand(),
            expr,
            !when_truthy,
        );
    }
    if !ast::is_binary_expression(unwrapped) {
        return false;
    }
    binary_condition_ensures_string(unwrapped.as_binary_expression(), expr, when_truthy)
}

fn statement_always_exits(stmt: Option<P<Node>>) -> bool {
    let Some(node) = stmt else {
        return false;
    };
    match node.kind() {
        Kind::ReturnStatement
        | Kind::ThrowStatement
        | Kind::ContinueStatement
        | Kind::BreakStatement => true,
        Kind::Block => node
            .as_block()
            .statements()
            .nodes()
            .last()
            .copied()
            .is_some_and(|last| statement_always_exits(Some(last))),
        Kind::IfStatement => {
            let if_stmt = node.as_if_statement();
            statement_always_exits(Some(if_stmt.then_statement()))
                && statement_always_exits(if_stmt.else_statement())
        }
        _ => false,
    }
}

fn node_within(node: P<Node>, ancestor: P<Node>) -> bool {
    let mut current = Some(node);
    while let Some(curr) = current {
        if curr == ancestor {
            return true;
        }
        current = curr.parent();
    }
    false
}

fn has_enclosing_if_string_guard(call_node: P<Node>, arg_expr: P<Node>) -> bool {
    let mut current = call_node.parent();
    while let Some(curr) = current {
        if ast::is_if_statement(curr) {
            let if_stmt = curr.as_if_statement();
            if node_within(call_node, if_stmt.then_statement())
                && condition_ensures_string(if_stmt.expression(), arg_expr, true)
            {
                return true;
            }
            if let Some(else_stmt) = if_stmt.else_statement()
                && node_within(call_node, else_stmt)
                && condition_ensures_string(if_stmt.expression(), arg_expr, false)
            {
                return true;
            }
        }
        current = curr.parent();
    }
    false
}

fn enclosing_block_statement(start: P<Node>) -> Option<P<Node>> {
    let mut current = Some(start);
    while let Some(curr) = current {
        let parent = curr.parent()?;
        if ast::is_block(parent) {
            return Some(curr);
        }
        current = Some(parent);
    }
    None
}

fn preceding_early_exit_guard_ensures_string(
    stmts: &[P<Node>],
    idx: usize,
    arg_expr: P<Node>,
) -> bool {
    let Some(&candidate) = stmts.get(..idx).and_then(|prefix| {
        prefix
            .iter()
            .rev()
            .find(|&&stmt| !ast::is_variable_statement(stmt))
    }) else {
        return false;
    };
    if !ast::is_if_statement(candidate) {
        return false;
    }
    let if_stmt = candidate.as_if_statement();
    if statement_always_exits(Some(if_stmt.then_statement()))
        && condition_ensures_string(if_stmt.expression(), arg_expr, false)
    {
        return true;
    }
    if_stmt.else_statement().is_some_and(|else_stmt| {
        statement_always_exits(Some(else_stmt))
            && condition_ensures_string(if_stmt.expression(), arg_expr, true)
    })
}

pub(super) fn has_local_string_boundary(call_node: P<Node>, arg_expr: P<Node>) -> bool {
    if has_enclosing_if_string_guard(call_node, arg_expr) {
        return true;
    }
    let mut current = Some(call_node);
    while let Some(curr) = current {
        let Some(stmt) = enclosing_block_statement(curr) else {
            break;
        };
        let Some(parent) = stmt.parent() else {
            break;
        };
        if !ast::is_block(parent) {
            break;
        }
        let stmts = parent.as_block().statements().nodes();
        if let Some(idx) = stmts.iter().position(|&item| item == stmt)
            && preceding_early_exit_guard_ensures_string(stmts, idx, arg_expr)
        {
            return true;
        }
        let Some(owner) = parent.parent() else {
            break;
        };
        if tsrs_kernel::is_function_like(owner) {
            break;
        }
        current = Some(owner);
    }
    false
}
