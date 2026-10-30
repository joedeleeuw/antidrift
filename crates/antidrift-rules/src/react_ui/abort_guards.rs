use super::lifecycle_state_frame::StateFrame;
use antidrift_kernel::tsrs_kernel::{is_function_like, unwrap_expression};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::{P, TextPos};

pub(super) struct AbortGuard {
    pub(super) block: P<Node>,
    pub(super) start: Option<TextPos>,
    pub(super) end: TextPos,
}

pub(super) fn non_computed_member(expression: P<Node>, target: &str) -> Option<P<Node>> {
    let inner = unwrap_expression(expression);
    if inner.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = inner.as_property_access_expression();
    let prop = access.name();
    (ast::is_identifier(prop) && prop.as_identifier().text() == target).then(|| access.expression())
}

fn is_known_controller(expression: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(expression);
    if ast::is_identifier(inner) {
        let name = inner.as_identifier().text();
        return stack.iter().any(|frame| frame.has_abort_controller(name));
    }
    non_computed_member(expression, "current").is_some_and(|obj| {
        let inner_obj = unwrap_expression(obj);
        ast::is_identifier(inner_obj)
            && stack
                .iter()
                .any(|frame| frame.has_abort_controller_ref(inner_obj.as_identifier().text()))
    })
}

fn is_abort_status_test(test: P<Node>, stack: &[StateFrame]) -> bool {
    let inner = unwrap_expression(test);
    if inner.kind() == Kind::BinaryExpression {
        let bin = inner.as_binary_expression();
        if matches!(
            bin.operator_token().kind(),
            Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
        ) {
            return is_abort_status_test(bin.left(), stack)
                || is_abort_status_test(bin.right(), stack);
        }
    }
    non_computed_member(test, "aborted")
        .and_then(|signal| non_computed_member(signal, "signal"))
        .is_some_and(|controller| is_known_controller(controller, stack))
}

fn statement_exits(statement: Option<P<Node>>) -> bool {
    let Some(stmt) = statement else { return false };
    match stmt.kind() {
        Kind::ReturnStatement
        | Kind::ThrowStatement
        | Kind::BreakStatement
        | Kind::ContinueStatement => true,
        Kind::Block => statement_exits(stmt.as_block().statements().nodes().last().copied()),
        Kind::IfStatement => {
            statement_exits(Some(stmt.as_if_statement().then_statement()))
                && statement_exits(stmt.as_if_statement().else_statement())
        }
        _ => false,
    }
}

fn statement_block(node: P<Node>) -> Option<P<Node>> {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if matches!(ancestor.kind(), Kind::Block | Kind::SourceFile) {
            return Some(ancestor);
        }
        if is_function_like(ancestor) {
            return None;
        }
        cursor = ancestor.parent();
    }
    None
}

pub(super) fn if_statement_guards(if_node: P<Node>, stack: &[StateFrame]) -> Vec<AbortGuard> {
    let mut guards = Vec::new();
    let stmt = if_node.as_if_statement();
    let (test, consequent) = (stmt.expression(), stmt.then_statement());
    if is_abort_status_test(test, stack)
        && statement_exits(Some(consequent))
        && let Some(block) = statement_block(if_node)
    {
        guards.push(AbortGuard {
            block,
            start: None,
            end: if_node.end(),
        });
    }
    let inner_test = unwrap_expression(test);
    if inner_test.kind() == Kind::PrefixUnaryExpression
        && inner_test.as_prefix_unary_expression().operator() == Kind::ExclamationToken
        && is_abort_status_test(inner_test.as_prefix_unary_expression().operand(), stack)
        && consequent.kind() == Kind::Block
    {
        guards.push(AbortGuard {
            block: consequent,
            start: Some(consequent.pos()),
            end: consequent.end(),
        });
    }
    guards
}

pub(super) fn is_guarded(guards: &[AbortGuard], node: P<Node>) -> bool {
    statement_block(node).is_some_and(|block| {
        let start = node.pos();
        guards.iter().any(|guard| {
            guard.block == block
                && guard
                    .start
                    .map_or(guard.end <= start, |s| s <= start && start <= guard.end)
        })
    })
}
