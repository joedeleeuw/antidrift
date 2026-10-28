use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-as-never";

pub struct NoAsNever {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoAsNever = NoAsNever {
    scope: RuleScope::DEFAULT,
};

impl NoAsNever {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::AsExpression)];

impl Rule for NoAsNever {
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
        if node.kind() != Kind::AsExpression {
            return;
        }
        let type_node = node.as_as_expression().type_();
        if is_never_type_annotation(type_node) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "forbidden",
                    "Do not cast to 'never'. Fix the type boundary instead.",
                ),
            );
        }
    }
}

fn is_never_type_annotation(type_node: P<Node>) -> bool {
    match type_node.kind() {
        Kind::NeverKeyword => true,
        Kind::TypeReference => {
            let name = type_node.as_type_reference_node().type_name();
            ast::is_identifier(name) && name.as_identifier().text() == "never"
        }
        _ => false,
    }
}
