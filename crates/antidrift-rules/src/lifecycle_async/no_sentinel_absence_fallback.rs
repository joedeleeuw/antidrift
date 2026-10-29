use super::syntax::unwrap_expression;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use antidrift_kernel::tsrs_kernel::node_text;
use serde::Deserialize;
use tsrs_ast::{Kind, Node};
use tsrs_checker::{Checker, TypeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrslint::utils::{is_object_type, is_type_flag_set, is_union_type};

pub const RULE_NAME: &str = "antidrift/no-sentinel-absence-fallback";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct AbsenceOptions {
    member_sentinels: bool,
    #[serde(flatten)]
    scope: ScopeOptions,
}

impl Default for AbsenceOptions {
    fn default() -> Self {
        Self {
            member_sentinels: true,
            scope: ScopeOptions::default(),
        }
    }
}

pub struct NoSentinelAbsenceFallback {
    member_sentinels: bool,
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoSentinelAbsenceFallback = NoSentinelAbsenceFallback {
    member_sentinels: true,
    scope: RuleScope::DEFAULT,
};

impl NoSentinelAbsenceFallback {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let decoded = decode_rule_options::<AbsenceOptions>(RULE_NAME, options)?;
        let scope = RuleScope::from_scope_options(RULE_NAME, &decoded.scope)?;
        Ok(Self {
            member_sentinels: decoded.member_sentinels,
            scope,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::BinaryExpression),
    Listener::Enter(Kind::CatchClause),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoSentinelAbsenceFallback {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor {
            member_sentinels: self.member_sentinels,
        })
    }
}

struct Visitor {
    member_sentinels: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() == Kind::CatchClause {
            if let Some(empty_ret) = catch_clause_empty_string_sentinel(node) {
                ctx.report_node(
                    empty_ret,
                    RuleMessage::new(
                        "catchSentinelReturn",
                        "This catch branch collapses a failure or missing-resource error into \"\", erasing the distinction between absence and an empty string. Return null/undefined or a typed result union instead.",
                    ),
                );
            }
            return;
        }
        if node.kind() == Kind::CallExpression {
            if let Some(empty_ret) = promise_catch_empty_string_sentinel(node) {
                ctx.report_node(
                    empty_ret,
                    RuleMessage::new(
                        "catchSentinelReturn",
                        "This .catch() handler collapses a rejected promise into \"\", erasing the distinction between absence and an empty string. Return null/undefined or a typed result union instead.",
                    ),
                );
            }
            return;
        }
        if !self.member_sentinels || is_direct_jsx_text_expression(node) {
            return;
        }
        let bin = node.as_binary_expression();
        let op = bin.operator_token().kind();
        if op == Kind::QuestionQuestionToken
            && matches!(
                unwrap_expression(bin.left()).kind(),
                Kind::PropertyAccessExpression | Kind::ElementAccessExpression
            )
            && let Some(sentinel) = string_literal(bin.right())
            && ["unknown", "n/a", "none", "unavailable", "error", "missing"]
                .contains(&sentinel.to_lowercase().as_str())
        {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "sentinelAbsenceFallback",
                    format!(
                        "This fallback hides a missing member behind \"{sentinel}\". Keep the missing value distinct from a reported value."
                    ),
                ),
            );
            return;
        }
        if let Some((subject, sentinel)) =
            dual_empty_sentinel_guard(ctx, bin.left(), op, bin.right())
            && has_object_string_nullish_union(ctx.checker, subject)
        {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "dualEmptySentinel",
                    format!(
                        "This check collapses nullishness and string sentinel \"{sentinel}\" on the same union. Model absence once instead of mixing undefined/null with \"{sentinel}\"."
                    ),
                ),
            );
        }
    }
}

fn dual_empty_sentinel_guard(
    ctx: &Ctx,
    left: P<Node>,
    op: Kind,
    right: P<Node>,
) -> Option<(P<Node>, &'static str)> {
    let left_inner = unwrap_expression(left);
    let right_inner = unwrap_expression(right);
    if right_inner.kind() != Kind::BinaryExpression {
        return None;
    }
    let cmp = right_inner.as_binary_expression();
    let cmp_op = cmp.operator_token().kind();
    let (subject, expected_cmp) = match op {
        Kind::BarBarToken if left_inner.kind() == Kind::PrefixUnaryExpression => {
            let prefix = left_inner.as_prefix_unary_expression();
            if prefix.operator() != Kind::ExclamationToken {
                return None;
            }
            (
                unwrap_expression(prefix.operand()),
                &[Kind::EqualsEqualsEqualsToken, Kind::EqualsEqualsToken][..],
            )
        }
        Kind::AmpersandAmpersandToken => (
            left_inner,
            &[
                Kind::ExclamationEqualsEqualsToken,
                Kind::ExclamationEqualsToken,
            ][..],
        ),
        _ => return None,
    };
    if !expected_cmp.contains(&cmp_op) {
        return None;
    }
    let (cmp_subj, sentinel) = if let Some(s) = string_literal(cmp.right()) {
        (unwrap_expression(cmp.left()), s)
    } else {
        let s = string_literal(cmp.left())?;
        (unwrap_expression(cmp.right()), s)
    };
    let subj_text = node_text(ctx.file, subject).trim();
    let cmp_text = node_text(ctx.file, cmp_subj).trim();
    (!subj_text.is_empty() && subj_text == cmp_text).then_some((subject, sentinel))
}

fn has_object_string_nullish_union(checker: &mut Checker, subject: P<Node>) -> bool {
    let typ = checker.get_type_at_location(subject);
    if !is_union_type(typ) {
        return false;
    }
    let mut has_obj = false;
    let mut has_str_lit = false;
    let mut has_nullish = false;
    for &part in typ.types() {
        if is_object_type(part)
            || is_type_flag_set(part, TypeFlags::Object | TypeFlags::NonPrimitive)
        {
            has_obj = true;
        } else if is_type_flag_set(part, TypeFlags::StringLiteral) {
            has_str_lit = true;
        } else if is_type_flag_set(
            part,
            TypeFlags::Undefined | TypeFlags::Null | TypeFlags::Void,
        ) {
            has_nullish = true;
        }
    }
    has_obj && has_str_lit && has_nullish
}

fn is_direct_jsx_text_expression(node: P<Node>) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == Kind::ParenthesizedExpression {
            current = parent.parent();
            continue;
        }
        if parent.kind() == Kind::JsxExpression {
            return parent
                .parent()
                .is_some_and(|gp| matches!(gp.kind(), Kind::JsxElement | Kind::JsxFragment));
        }
        return false;
    }
    false
}

fn string_literal(expression: P<Node>) -> Option<&'static str> {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::StringLiteral => Some(inner.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => Some(inner.text()),
        _ => None,
    }
}

fn find_empty_string_return(node: P<Node>) -> Option<P<Node>> {
    if node.kind() == Kind::ReturnStatement {
        let expr = node.as_return_statement().expression()?;
        return string_literal(expr).filter(|s| s.is_empty()).map(|_| node);
    }
    let mut found = None;
    node.for_each_child(&mut |child| {
        if found.is_none()
            && !matches!(
                child.kind(),
                Kind::FunctionDeclaration
                    | Kind::FunctionExpression
                    | Kind::ArrowFunction
                    | Kind::MethodDeclaration
            )
        {
            found = find_empty_string_return(child);
        }
        found.is_some()
    });
    found
}

fn block_has_non_empty_return(node: P<Node>) -> bool {
    if node.kind() == Kind::ReturnStatement {
        return node
            .as_return_statement()
            .expression()
            .is_some_and(|expr| string_literal(expr) != Some(""));
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        if !found
            && !matches!(
                child.kind(),
                Kind::FunctionDeclaration
                    | Kind::FunctionExpression
                    | Kind::ArrowFunction
                    | Kind::MethodDeclaration
            )
        {
            found = block_has_non_empty_return(child);
        }
        found
    });
    found
}

fn catch_clause_empty_string_sentinel(catch_node: P<Node>) -> Option<P<Node>> {
    let try_stmt = catch_node
        .parent()
        .filter(|p| p.kind() == Kind::TryStatement)?;
    if !block_has_non_empty_return(try_stmt.as_try_statement().try_block()) {
        return None;
    }
    find_empty_string_return(catch_node.as_catch_clause().block())
}

fn promise_catch_empty_string_sentinel(call_node: P<Node>) -> Option<P<Node>> {
    let call = call_node.as_call_expression();
    let callee = unwrap_expression(call.expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return None;
    }
    let prop = callee.as_property_access_expression();
    let name = prop.name();
    if name.kind() != Kind::Identifier || name.as_identifier().text() != "catch" {
        return None;
    }
    let &handler = call.arguments().nodes().first()?;
    let handler = unwrap_expression(handler);
    if !matches!(
        handler.kind(),
        Kind::ArrowFunction | Kind::FunctionExpression
    ) {
        return None;
    }
    let body = handler.body()?;
    if body.kind() == Kind::Block {
        find_empty_string_return(body)
    } else {
        string_literal(body).filter(|s| s.is_empty()).map(|_| body)
    }
}
