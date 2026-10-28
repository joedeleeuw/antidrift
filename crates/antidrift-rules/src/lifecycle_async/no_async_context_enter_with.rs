use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-async-context-enter-with";

pub struct NoAsyncContextEnterWith {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAsyncContextEnterWith = NoAsyncContextEnterWith {
    scope: RuleScope::DEFAULT,
};

impl NoAsyncContextEnterWith {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoAsyncContextEnterWith {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: self.scope.in_scope(ctx),
        })
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
        let callee = node.as_call_expression().expression();
        if callee.kind() == Kind::PropertyAccessExpression {
            let name = callee.as_property_access_expression().name();
            if ast::is_identifier(name) && name.as_identifier().text() == "enterWith" {
                ctx.report_node(
                    node,
                    RuleMessage::new(
                        "noEnterWith",
                        "Do not use AsyncLocalStorage.enterWith(): it mutates the ambient async context frame with no restore point, so background work that resumes there adopts the store. Scope it with run(...) at the boundary instead (see request-scope.ts).",
                    ),
                );
            }
        }
    }
}
