use antidrift_kernel::decode_guards::{
    is_line_chunk_identifier, is_parser_module_path, is_sniffer_function_name,
};
use antidrift_kernel::local_binding::collect_identifier_references_in_subtree;
use antidrift_kernel::projection::is_nullish_expression;
use antidrift_kernel::tsrs_kernel::{
    collect_return_expressions, function_name, is_function_like, member_chain_root_identifier,
    terminal_member_name, unwrap_awaited_expression, unwrap_expression,
};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};

const FALLBACK_MESSAGE: &str = "Failure path drops the error and returns an empty collection, which makes bad data look valid. Let the error propagate or return a typed failure.";

const SAFE_DECODE_METHODS: &[&str] = &["safeParse", "safeParseAsync"];
const THROWING_DECODE_METHODS: &[&str] =
    &["parse", "parseAsync", "decodeUnknownSync", "decodeSync"];

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

fn decode_to_nullable_message(callee: &str, sentinel: &str) -> RuleMessage {
    RuleMessage::new(
        "decodeToNullable",
        format!(
            "Boundary decode '{callee}' is collapsed to {sentinel}, erasing schema and syntax failures into absence; propagate or report the decode error explicitly."
        ),
    )
}

fn is_absent_sentinel(expr: P<Node>) -> bool {
    is_nullish_expression(expr) || is_empty_collection_expr(expr)
}

fn decode_callee(call: P<Node>, methods: &[&str]) -> Option<String> {
    if call.kind() != Kind::CallExpression {
        return None;
    }
    let callee = unwrap_expression(call.as_call_expression().expression());
    let method = terminal_member_name(callee)?;
    let root = member_chain_root_identifier(callee);
    if root == Some("JSON") && method == "parse" {
        return Some("JSON.parse".to_owned());
    }
    methods
        .contains(&method)
        .then(|| root.map_or_else(|| method.to_owned(), |root| format!("{root}.{method}")))
}

fn decode_argument_is_line_chunk(call: P<Node>) -> bool {
    call.as_call_expression()
        .arguments()
        .nodes()
        .first()
        .is_some_and(|&arg| {
            let unwrapped = unwrap_expression(arg);
            ast::is_identifier(unwrapped)
                && is_line_chunk_identifier(unwrapped.as_identifier().text())
        })
}

fn is_exempt_decode_site(ctx: &Ctx, node: P<Node>) -> bool {
    if is_parser_module_path(ctx.file.file_name()) {
        return true;
    }
    let mut cursor = node.parent();
    while let Some(current) = cursor {
        if is_function_like(current) {
            return function_name(current).is_some_and(is_sniffer_function_name)
                || current.parameters().iter().any(|&param| {
                    let name = param.as_parameter_declaration().name();
                    ast::is_identifier(name)
                        && is_line_chunk_identifier(name.as_identifier().text())
                });
        }
        if matches!(
            current.kind(),
            Kind::ForStatement
                | Kind::ForOfStatement
                | Kind::ForInStatement
                | Kind::WhileStatement
                | Kind::DoStatement
        ) {
            return true;
        }
        cursor = current.parent();
    }
    false
}

fn safe_decode_data_read(expr: P<Node>) -> Option<String> {
    let unwrapped = unwrap_awaited_expression(expr);
    if unwrapped.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = unwrapped.as_property_access_expression();
    if terminal_member_name(unwrapped) != Some("data") {
        return None;
    }
    let call = unwrap_awaited_expression(access.expression());
    let callee = decode_callee(call, SAFE_DECODE_METHODS)?;
    (!decode_argument_is_line_chunk(call)).then_some(callee)
}

pub(super) fn check_decode_to_nullable_expression(ctx: &mut Ctx, node: P<Node>) {
    let (callee, sentinel) = match node.kind() {
        Kind::BinaryExpression => {
            let bin = node.as_binary_expression();
            if bin.operator_token().kind() != Kind::QuestionQuestionToken
                || !is_absent_sentinel(bin.right())
            {
                return;
            }
            let Some(callee) = safe_decode_data_read(bin.left()) else {
                return;
            };
            (callee, "'??' fallback")
        }
        Kind::ConditionalExpression => {
            let cond = node.as_conditional_expression();
            let test = unwrap_expression(cond.condition());
            let (success_root, negated) = if ast::is_prefix_unary_expression(test) {
                (
                    unwrap_expression(test.as_prefix_unary_expression().operand()),
                    true,
                )
            } else {
                (test, false)
            };
            if terminal_member_name(success_root) != Some("success") {
                return;
            }
            let Some(result_root) = member_chain_root_identifier(success_root) else {
                return;
            };
            let (data_branch, sentinel_branch) = if negated {
                (cond.when_false(), cond.when_true())
            } else {
                (cond.when_true(), cond.when_false())
            };
            let data = unwrap_expression(data_branch);
            if !is_absent_sentinel(sentinel_branch)
                || terminal_member_name(data) != Some("data")
                || member_chain_root_identifier(data) != Some(result_root)
            {
                return;
            }
            (format!("{result_root}.success"), "a conditional sentinel")
        }
        _ => return,
    };
    if !is_returned_value(node) || is_exempt_decode_site(ctx, node) {
        return;
    }
    ctx.report_node(node, decode_to_nullable_message(&callee, sentinel));
}

fn is_returned_value(node: P<Node>) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        match parent.kind() {
            Kind::ParenthesizedExpression | Kind::AsExpression | Kind::SatisfiesExpression => {
                current = parent;
            }
            Kind::ReturnStatement => return true,
            Kind::ArrowFunction => {
                return parent.body() == Some(current)
                    && !parent
                        .parent()
                        .is_some_and(|owner| owner.kind() == Kind::CallExpression);
            }
            _ => return false,
        }
    }
    false
}

fn find_decode_call(node: P<Node>) -> Option<String> {
    if let Some(callee) = decode_callee(node, THROWING_DECODE_METHODS)
        && !decode_argument_is_line_chunk(node)
    {
        return Some(callee);
    }
    let mut found = None;
    node.for_each_child(&mut |child| {
        if found.is_none() && !is_function_like(child) {
            found = find_decode_call(child);
        }
        found.is_some()
    });
    found
}

pub(super) fn check_decode_catch_to_nullable(ctx: &mut Ctx, catch_node: P<Node>) {
    let Some(try_statement) = catch_node.parent() else {
        return;
    };
    if try_statement.kind() != Kind::TryStatement {
        return;
    }
    let Some(callee) = find_decode_call(try_statement.as_try_statement().try_block()) else {
        return;
    };
    let catch_clause = catch_node.as_catch_clause();
    let block = catch_clause.block();
    let param_used = catch_clause
        .variable_declaration()
        .and_then(|decl| decl.name())
        .is_some_and(|name| pattern_has_references_in_subtree(name, block));
    if param_used || subtree_rethrows(block) || is_exempt_decode_site(ctx, catch_node) {
        return;
    }
    for ret_expr in collect_return_expressions(Some(block)) {
        if is_nullish_expression(ret_expr) {
            let target = ret_expr
                .parent()
                .filter(|parent| parent.kind() == Kind::ReturnStatement)
                .unwrap_or(ret_expr);
            ctx.report_node(
                target,
                decode_to_nullable_message(&callee, "a nullish catch return"),
            );
        }
    }
}
