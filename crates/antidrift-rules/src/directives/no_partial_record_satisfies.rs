use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel::{is_const_assertion, unwrap_parentheses};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-partial-record-satisfies";
const MESSAGE: &str = "Don't pin an object literal with `satisfies Partial<Record<...>>` — Partial cancels the totality check satisfies would otherwise give you, so a union member can silently fall through. Make the record total (explicit 'none'/false/null per member), narrow the key union, or add an eslint-disable naming what absence means for genuinely sparse data.";

pub struct NoPartialRecordSatisfies {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoPartialRecordSatisfies = NoPartialRecordSatisfies {
    scope: RuleScope::DEFAULT,
};

impl NoPartialRecordSatisfies {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::SatisfiesExpression)];

impl Rule for NoPartialRecordSatisfies {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = self.scope.matches(ctx.file.file_name(), cwd);
        Box::new(Visitor { enabled })
    }
}

struct Visitor {
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if node.kind() != Kind::SatisfiesExpression {
            return;
        }
        let sat = node.as_satisfies_expression();
        if is_partial_record_type(sat.type_()) && is_object_literal_expr(sat.expression()) {
            ctx.report_node(node, RuleMessage::new("noPartialRecordSatisfies", MESSAGE));
        }
    }
}

fn unwrap_readonly_type(type_node: P<Node>) -> P<Node> {
    if type_node.kind() == Kind::TypeReference {
        let type_ref = type_node.as_type_reference_node();
        if is_type_name_ident(type_ref.type_name(), "Readonly")
            && let Some(&first) = type_node.type_arguments().first()
        {
            return first;
        }
    }
    type_node
}

fn is_partial_record_type(type_node: P<Node>) -> bool {
    let outer = unwrap_readonly_type(type_node);
    if outer.kind() != Kind::TypeReference {
        return false;
    }
    let outer_ref = outer.as_type_reference_node();
    if !is_type_name_ident(outer_ref.type_name(), "Partial") {
        return false;
    }
    let Some(&first_arg) = outer.type_arguments().first() else {
        return false;
    };
    let inner = unwrap_readonly_type(first_arg);
    if inner.kind() != Kind::TypeReference {
        return false;
    }
    is_type_name_ident(inner.as_type_reference_node().type_name(), "Record")
}

fn is_type_name_ident(name_node: P<Node>, expected: &str) -> bool {
    ast::is_identifier(name_node) && name_node.as_identifier().text() == expected
}

fn is_object_literal_expr(expr: P<Node>) -> bool {
    let unwrapped = unwrap_parentheses(expr);
    match unwrapped.kind() {
        Kind::ObjectLiteralExpression => true,
        Kind::AsExpression => {
            let as_expr = unwrapped.as_as_expression();
            is_const_assertion(as_expr.type_()) && is_object_literal_expr(as_expr.expression())
        }
        _ => false,
    }
}
