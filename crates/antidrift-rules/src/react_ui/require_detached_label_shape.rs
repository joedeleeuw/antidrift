use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-detached-label-shape";
const MISSING_LABEL: &str = "`detached(promise, context)` needs a context label. Pass a `\"feature.action\"` string literal naming the module and the work being detached.";
const NON_LITERAL_LABEL: &str = "The `detached` context label must be a plain `\"feature.action\"` string literal, so the telemetry tag stays stable and cannot carry an interpolated identifier. If a helper detaches for several call sites, return the promise and let each site pass its own literal.";
const BAD_LABEL_SHAPE: &str = "The `detached` context label must be two lowercase kebab-case segments, `\"feature.action\"` (for example `\"template-list.invalidate-templates\"`). Name the module or route slice, then the work being detached; an enclosing component or handler name is neither stable nor distinguishing.";

pub struct RequireDetachedLabelShape {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireDetachedLabelShape = RequireDetachedLabelShape {
    scope: RuleScope::DEFAULT,
};

impl RequireDetachedLabelShape {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireDetachedLabelShape {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
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
        let call = node.as_call_expression();
        let callee = call.expression();
        if !ast::is_identifier(callee) || callee.as_identifier().text() != "detached" {
            return;
        }
        match call.arguments().nodes().get(1) {
            None => ctx.report_node(node, RuleMessage::new("missingLabel", MISSING_LABEL)),
            Some(&label) if label.kind() == Kind::StringLiteral => {
                if !is_label_shape(label.as_string_literal().text()) {
                    ctx.report_node(label, RuleMessage::new("badLabelShape", BAD_LABEL_SHAPE));
                }
            }
            Some(&label) => {
                ctx.report_node(
                    label,
                    RuleMessage::new("nonLiteralLabel", NON_LITERAL_LABEL),
                );
            }
        }
    }
}

fn is_kebab_word(segment: &str) -> bool {
    !segment.is_empty()
        && segment.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn is_label_shape(label: &str) -> bool {
    label
        .split_once('.')
        .is_some_and(|(feature, action)| is_kebab_word(feature) && is_kebab_word(action))
}
