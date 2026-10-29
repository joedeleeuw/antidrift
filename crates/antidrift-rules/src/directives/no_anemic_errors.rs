use super::anemic_error_fallback::{
    callee_property_name, check_catch_clause_fallback, check_decode_catch_to_nullable,
    check_decode_to_nullable_expression, check_promise_catch_call_fallback, expr_ident_name,
    is_error_member_read,
};
use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel::{
    is_test_or_spec_file, property_name_text, unwrap_awaited_expression, unwrap_expression,
};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-anemic-errors";

const VAGUE_ERROR_MESSAGES: &[&str] = &[
    "failed",
    "error",
    "something went wrong",
    "an error occurred",
    "unknown error",
    "unexpected error",
    "oops",
    "failure",
    "internal error",
    "server error",
];

const BARE_ERROR_CTORS: &[&str] = &[
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
];

const LOGGER_OBJECTS: &[&str] = &["console", "logger", "log"];
const LOGGER_METHODS: &[&str] = &["debug", "error", "fatal", "info", "log", "trace", "warn"];

pub struct NoAnemicErrors {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAnemicErrors = NoAnemicErrors {
    scope: RuleScope::DEFAULT,
};

impl NoAnemicErrors {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CatchClause),
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::ThrowStatement),
    Listener::Enter(Kind::ReturnStatement),
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::ConditionalExpression),
];

impl Rule for NoAnemicErrors {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let filename = ctx.file.file_name().replace('\\', "/");
        let enabled = self.scope.matches(&filename, cwd);
        let is_test = is_test_or_spec_file(&filename);
        Box::new(Visitor { enabled, is_test })
    }
}

struct Visitor {
    enabled: bool,
    is_test: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        match node.kind() {
            Kind::CatchClause => {
                check_catch_clause_fallback(ctx, node);
                if !self.is_test {
                    check_decode_catch_to_nullable(ctx, node);
                }
                if !self.is_test
                    && let Some(param_name) = catch_clause_param_name(node)
                {
                    let stmts = node
                        .as_catch_clause()
                        .block()
                        .as_block()
                        .statements()
                        .nodes();
                    inspect_catch_statements(ctx, stmts, param_name);
                }
            }
            Kind::CallExpression => {
                check_promise_catch_call_fallback(ctx, node);
                if !self.is_test
                    && let Some((param_name, stmts)) = extract_catch_callback(node)
                {
                    inspect_catch_statements(ctx, stmts, param_name);
                }
            }
            Kind::ThrowStatement if !self.is_test => {
                let active_param = find_enclosing_catch_param(node);
                check_throw_statement(ctx, node, active_param);
            }
            Kind::ReturnStatement if !self.is_test => {
                check_return_statement(ctx, node);
            }
            Kind::BinaryExpression | Kind::ConditionalExpression if !self.is_test => {
                check_decode_to_nullable_expression(ctx, node);
            }
            _ => {}
        }
    }
}

fn check_return_statement(ctx: &mut Ctx, node: P<Node>) {
    let Some(expr) = node.as_return_statement().expression() else {
        return;
    };
    let unwrapped = unwrap_expression(expr);
    if unwrapped.kind() == Kind::ObjectLiteralExpression && is_anemic_return_object(unwrapped) {
        ctx.report_node(
            node,
            RuleMessage::new(
                "anemicReturn",
                "Returning a generic error object is forbidden. Include the failed operation and its input context in the returned error contract.",
            ),
        );
    }
}

fn catch_clause_param_name(catch_node: P<Node>) -> Option<&'static str> {
    let decl = catch_node.as_catch_clause().variable_declaration()?;
    let name = decl.name()?;
    ast::is_identifier(name).then(|| name.as_identifier().text())
}

fn extract_catch_callback(call_node: P<Node>) -> Option<(&'static str, &'static [P<Node>])> {
    let call = call_node.as_call_expression();
    if callee_property_name(call.expression()) != Some("catch") {
        return None;
    }
    let first_arg = unwrap_expression(*call.arguments().nodes().first()?);
    if !matches!(
        first_arg.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) {
        return None;
    }
    let first_param = *first_arg.parameters().first()?;
    let name = first_param.name()?;
    if !ast::is_identifier(name) {
        return None;
    }
    let body = first_arg.body()?;
    if body.kind() != Kind::Block {
        return None;
    }
    Some((
        name.as_identifier().text(),
        body.as_block().statements().nodes(),
    ))
}

fn find_enclosing_catch_param(node: P<Node>) -> Option<&'static str> {
    let mut cursor = node.parent();
    while let Some(curr) = cursor {
        if curr.kind() == Kind::CatchClause {
            if let Some(name) = catch_clause_param_name(curr) {
                return Some(name);
            }
        } else if matches!(curr.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
            && let Some(parent) = curr.parent()
            && parent.kind() == Kind::CallExpression
            && let Some((name, _)) = extract_catch_callback(parent)
        {
            return Some(name);
        }
        cursor = curr.parent();
    }
    None
}

fn inspect_catch_statements(ctx: &mut Ctx, stmts: &[P<Node>], error_name: &str) {
    if stmts.len() != 2 || stmts[1].kind() != Kind::ThrowStatement {
        return;
    }
    let throw_stmt = stmts[1];
    let thrown_expr = throw_stmt.as_throw_statement().expression();
    if expr_ident_name(thrown_expr) == Some(error_name)
        && is_logger_statement_for_error(stmts[0], error_name)
    {
        ctx.report_node(
            throw_stmt,
            RuleMessage::new(
                "catchLogRethrow",
                format!(
                    "Logging caught error '{error_name}' and immediately re-throwing it unmodified duplicates error logging across every frame on the call stack. Either handle the error here, wrap it with domain context and `{{ cause: {error_name} }}`, or let it propagate and log once at the boundary."
                ),
            ),
        );
    }
}

fn is_logger_statement_for_error(stmt: P<Node>, error_name: &str) -> bool {
    if stmt.kind() != Kind::ExpressionStatement {
        return false;
    }
    let expr = unwrap_awaited_expression(stmt.as_expression_statement().expression());
    if expr.kind() != Kind::CallExpression {
        return false;
    }
    let call = expr.as_call_expression();
    let Some((receiver, method)) = logger_receiver_and_method(call.expression()) else {
        return false;
    };
    if !LOGGER_OBJECTS.contains(&receiver) || !LOGGER_METHODS.contains(&method) {
        return false;
    }
    call.arguments().nodes().iter().any(|&arg| {
        expr_ident_name(arg) == Some(error_name)
            || is_error_member_read(arg, error_name, &["message", "stack"])
    })
}

fn logger_receiver_and_method(callee: P<Node>) -> Option<(&'static str, &'static str)> {
    let unwrapped = unwrap_expression(callee);
    if unwrapped.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let access = unwrapped.as_property_access_expression();
    let method_node = access.name();
    if !ast::is_identifier(method_node) {
        return None;
    }
    let method = method_node.as_identifier().text();
    let obj = unwrap_expression(access.expression());
    let receiver = match obj.kind() {
        Kind::Identifier => obj.as_identifier().text(),
        Kind::PropertyAccessExpression => {
            let inner_name = obj.as_property_access_expression().name();
            if !ast::is_identifier(inner_name) {
                return None;
            }
            inner_name.as_identifier().text()
        }
        _ => return None,
    };
    Some((receiver, method))
}

fn check_throw_statement(ctx: &mut Ctx, throw_node: P<Node>, active_catch_param: Option<&str>) {
    let arg = unwrap_expression(throw_node.as_throw_statement().expression());
    let (callee, args) = match arg.kind() {
        Kind::NewExpression => {
            let new_expr = arg.as_new_expression();
            let slice = new_expr.arguments().map_or(&[][..], |list| list.nodes());
            (new_expr.expression(), slice)
        }
        Kind::CallExpression => {
            let call_expr = arg.as_call_expression();
            (call_expr.expression(), call_expr.arguments().nodes())
        }
        _ => return,
    };
    let Some(ctor_name) = expr_ident_name(callee) else {
        return;
    };
    if !BARE_ERROR_CTORS.contains(&ctor_name) {
        return;
    }
    let Some(&first_arg) = args.first() else {
        return;
    };
    let unwrapped_first = unwrap_expression(first_arg);
    if ctor_name == "Error"
        && unwrapped_first.kind() == Kind::StringLiteral
        && is_vague_error_message(unwrapped_first.as_string_literal().text())
    {
        let message = unwrapped_first.as_string_literal().text();
        ctx.report_node(
            throw_node,
            RuleMessage::new(
                "anemicThrow",
                format!(
                    "Error message '{message}' is too vague. Include context about what failed and why."
                ),
            ),
        );
        return;
    }
    if let Some(error_name) = active_catch_param
        && args.len() == 1
        && is_bare_caught_error_message(first_arg, error_name)
    {
        ctx.report_node(
            throw_node,
            RuleMessage::new(
                "lossyErrorRethrow",
                format!(
                    "Re-throwing caught error '{error_name}' as a bare `new Error({error_name}.message)` discards its stack trace, cause chain, and error class with no added context. Rethrow `{error_name}` directly, wrap with `{{ cause: {error_name} }}` and domain context, or throw a typed domain error."
                ),
            ),
        );
    }
}

fn is_bare_caught_error_message(expr: P<Node>, error_name: &str) -> bool {
    let target = unwrap_expression(expr);
    if expr_ident_name(target) == Some(error_name)
        || is_error_member_read(target, error_name, &["message", "stack"])
    {
        return true;
    }
    match target.kind() {
        Kind::CallExpression => {
            let call = target.as_call_expression();
            let args = call.arguments().nodes();
            if expr_ident_name(call.expression()) == Some("String") && args.len() == 1 {
                return expr_ident_name(args[0]) == Some(error_name)
                    || is_error_member_read(args[0], error_name, &["message"]);
            }
            args.is_empty() && is_error_member_read(call.expression(), error_name, &["toString"])
        }
        Kind::TemplateExpression => {
            let tpl = target.as_template_expression();
            let head_empty = tpl.head().as_template_head().text().trim().is_empty();
            let spans = tpl.template_spans().nodes();
            head_empty
                && spans.len() == 1
                && spans[0]
                    .as_template_span()
                    .literal()
                    .text()
                    .trim()
                    .is_empty()
                && is_bare_caught_error_message(
                    spans[0].as_template_span().expression(),
                    error_name,
                )
        }
        Kind::ConditionalExpression => {
            let cond = target.as_conditional_expression();
            is_bare_caught_error_message(cond.when_true(), error_name)
                && is_bare_caught_error_message(cond.when_false(), error_name)
        }
        Kind::BinaryExpression => {
            let bin = target.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::QuestionQuestionToken | Kind::BarBarToken
            ) && is_bare_caught_error_message(bin.left(), error_name)
                && (is_bare_caught_error_message(bin.right(), error_name)
                    || unwrap_expression(bin.right()).kind() == Kind::StringLiteral)
        }
        _ => false,
    }
}

fn is_anemic_return_object(obj: P<Node>) -> bool {
    let mut has_success_false = false;
    let mut has_vague_error = false;
    for &prop in obj.as_object_literal_expression().properties().nodes() {
        if prop.kind() != Kind::PropertyAssignment {
            continue;
        }
        let assign = prop.as_property_assignment();
        let key_name = property_name_text(assign.name());
        let val = unwrap_expression(assign.initializer());
        if key_name == Some("success") && val.kind() == Kind::FalseKeyword {
            has_success_false = true;
        }
        if key_name == Some("error")
            && val.kind() == Kind::StringLiteral
            && is_vague_error_message(val.as_string_literal().text())
        {
            has_vague_error = true;
        }
    }
    has_success_false && has_vague_error
}

fn is_vague_error_message(msg: &str) -> bool {
    VAGUE_ERROR_MESSAGES
        .iter()
        .any(|candidate| msg.eq_ignore_ascii_case(candidate))
}
