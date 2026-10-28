use antidrift_kernel::local_binding::collect_identifier_references_in_subtree;
use antidrift_kernel::tsrs_kernel::{
    collect_return_expressions, is_function_like, terminal_member_name, unwrap_expression,
};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};

const FALLBACK_MESSAGE: &str = "Failure path drops the error and returns an empty collection, which makes bad data look valid. Let the error propagate or return a typed failure.";

pub(super) fn check_catch_clause_fallback(ctx: &mut Ctx, catch_node: P<Node>) {
    if catch_node.kind() != Kind::CatchClause {
        return;
    }
    let catch_clause = catch_node.as_catch_clause();
    let block = catch_clause.block();
    let param_used = catch_clause
        .variable_declaration()
        .and_then(|decl| decl.name())
        .is_some_and(|name| pattern_has_references_in_subtree(name, block));
    if !param_used && !subtree_rethrows(block) {
        report_empty_returns_in_block(ctx, block);
    }
}

pub(super) fn check_promise_catch_call_fallback(ctx: &mut Ctx, call_node: P<Node>) {
    if call_node.kind() != Kind::CallExpression {
        return;
    }
    let call = call_node.as_call_expression();
    if callee_property_name(call.expression()) != Some("catch") {
        return;
    }
    let Some(&first_arg) = call.arguments().nodes().first() else {
        return;
    };
    let arg = unwrap_expression(first_arg);
    if !matches!(arg.kind(), Kind::ArrowFunction | Kind::FunctionExpression) {
        return;
    }
    let Some(body) = arg.body() else {
        return;
    };
    let param_used = arg.parameters().iter().any(|&param| {
        param
            .name()
            .is_some_and(|name| pattern_has_references_in_subtree(name, body))
    });
    if param_used {
        return;
    }
    if body.kind() != Kind::Block {
        if is_empty_collection_expr(body) {
            ctx.report_node(arg, RuleMessage::new("fallback", FALLBACK_MESSAGE));
        }
    } else if !subtree_rethrows(body) {
        report_empty_returns_in_block(ctx, body);
    }
}

fn pattern_has_references_in_subtree(name_node: P<Node>, root: P<Node>) -> bool {
    if !ast::is_identifier(name_node) {
        return false;
    }
    !collect_identifier_references_in_subtree(root, name_node.as_identifier().text()).is_empty()
}

fn report_empty_returns_in_block(ctx: &mut Ctx, block: P<Node>) {
    for ret_expr in collect_return_expressions(Some(block)) {
        if is_empty_collection_expr(ret_expr) {
            let report_target = ret_expr
                .parent()
                .filter(|p| p.kind() == Kind::ReturnStatement)
                .unwrap_or(ret_expr);
            ctx.report_node(
                report_target,
                RuleMessage::new("fallback", FALLBACK_MESSAGE),
            );
        }
    }
}

fn is_empty_collection_expr(expr: P<Node>) -> bool {
    let unwrapped = unwrap_expression(expr);
    match unwrapped.kind() {
        Kind::ArrayLiteralExpression => unwrapped
            .as_array_literal_expression()
            .elements()
            .nodes()
            .is_empty(),
        Kind::ObjectLiteralExpression => unwrapped
            .as_object_literal_expression()
            .properties()
            .nodes()
            .is_empty(),
        _ => false,
    }
}

fn subtree_rethrows(node: P<Node>) -> bool {
    if node.kind() == Kind::ThrowStatement {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if found || is_function_like(child) {
            return true;
        }
        if subtree_rethrows(child) {
            found = true;
            return true;
        }
        false
    });
    found
}

pub(super) fn is_error_member_read(expr: P<Node>, error_name: &str, allowed: &[&str]) -> bool {
    let unwrapped = unwrap_expression(expr);
    if unwrapped.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = unwrapped.as_property_access_expression();
    let prop_name = access.name();
    expr_ident_name(access.expression()) == Some(error_name)
        && ast::is_identifier(prop_name)
        && allowed.contains(&prop_name.as_identifier().text())
}

pub(super) fn expr_ident_name(expr: P<Node>) -> Option<&'static str> {
    let unwrapped = unwrap_expression(expr);
    ast::is_identifier(unwrapped).then(|| unwrapped.as_identifier().text())
}

pub(super) fn callee_property_name(callee: P<Node>) -> Option<&'static str> {
    terminal_member_name(unwrap_expression(callee))
}
