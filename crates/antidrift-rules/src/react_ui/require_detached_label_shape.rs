use antidrift_kernel::rule_options::reject_unknown_options;
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-detached-label-shape";
const MISSING_LABEL: &str = "`detached(promise, context)` needs a context label. Pass a `\"feature.action\"` string literal naming the module and the work being detached.";
const NON_LITERAL_LABEL: &str = "The `detached` context label must be a plain `\"feature.action\"` string literal, so the telemetry tag stays stable and cannot carry an interpolated identifier. If a helper detaches for several call sites, return the promise and let each site pass its own literal.";
const BAD_LABEL_SHAPE: &str = "The `detached` context label must be two lowercase kebab-case segments, `\"feature.action\"` (for example `\"template-list.invalidate-templates\"`). Name the module or route slice, then the work being detached; an enclosing component or handler name is neither stable nor distinguishing.";

pub struct RequireDetachedLabelShape;

pub static DEFAULT_RULE: RequireDetachedLabelShape = RequireDetachedLabelShape;

impl RequireDetachedLabelShape {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        reject_unknown_options(RULE_NAME, options)?;
        Ok(Self)
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireDetachedLabelShape {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
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
                if cooked_text(label).is_some_and(|text| !is_label_shape(text)) {
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
