use super::syntax::unwrap;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope, ScopeOptions, decode_rule_options};
use serde::Deserialize;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

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

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::BinaryExpression)];

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
        if !self.member_sentinels || is_direct_jsx_text_expression(node) {
            return;
        }
        let bin = node.as_binary_expression();
        if bin.operator_token().kind() == Kind::QuestionQuestionToken
            && matches!(
                unwrap(bin.left()).kind(),
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
        }
    }
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
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::StringLiteral => Some(inner.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => Some(inner.text()),
        _ => None,
    }
}
