use antidrift_kernel::rule_scope::RuleScope;
use antidrift_kernel::tsrs_kernel::{assertion_parts, is_const_assertion, unwrap_parentheses};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unsafe-cast-chain";
const MESSAGE: &str = "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";

pub struct NoUnsafeCastChain {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoUnsafeCastChain = NoUnsafeCastChain {
    scope: RuleScope::DEFAULT,
};

impl NoUnsafeCastChain {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::AsExpression),
    Listener::Enter(Kind::TypeAssertionExpression),
];

impl Rule for NoUnsafeCastChain {
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
        let Some((inner, ty)) = assertion_parts(node) else {
            return;
        };
        if !is_outermost_assertion_in_chain(node) {
            return;
        }
        if is_forbidden_assertion_chain(inner, ty) {
            ctx.report_node(node, RuleMessage::new("chained", MESSAGE));
        }
    }
}

fn is_outermost_assertion_in_chain(node: P<Node>) -> bool {
    let mut cursor = node.parent();
    while let Some(parent) = cursor {
        match parent.kind() {
            Kind::ParenthesizedExpression => {
                cursor = parent.parent();
            }
            Kind::AsExpression | Kind::TypeAssertionExpression => return false,
            _ => return true,
        }
    }
    true
}

fn is_forbidden_assertion_chain(first_inner: P<Node>, first_ty: P<Node>) -> bool {
    let mut assertion_count = 1usize;
    let mut has_non_const = !is_const_assertion(first_ty);
    let mut current = unwrap_parentheses(first_inner);
    while let Some((next_inner, next_ty)) = assertion_parts(current) {
        assertion_count += 1;
        if !is_const_assertion(next_ty) {
            has_non_const = true;
        }
        current = unwrap_parentheses(next_inner);
    }
    assertion_count > 1 && has_non_const
}
