use antidrift_kernel::callgraph;
use antidrift_kernel::rule_options::reject_unknown_options;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

const RULE_NAME: &str = "antidrift/no-pass-through-parameters";

fn build_pass_through_message(name: &str, targets: &[String]) -> RuleMessage {
    RuleMessage::new(
        "passThrough",
        format!(
            "'{name}' is a pass-through variable: this function never reads it and only forwards it to {}. Let that layer obtain it from its owner, or move the work that needs it here.",
            targets.join(", ")
        ),
    )
}

pub struct NoPassThroughParameters;

impl NoPassThroughParameters {
    pub const DEFAULT: Self = Self;
}

pub static DEFAULT_INSTANCE: NoPassThroughParameters = NoPassThroughParameters::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    reject_unknown_options(RULE_NAME, options)?;
    Ok(Box::new(NoPassThroughParameters))
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::ArrowFunction),
    Listener::Enter(Kind::FunctionDeclaration),
    Listener::Enter(Kind::FunctionExpression),
];

impl Rule for NoPassThroughParameters {
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
        for matched in callgraph::find_pass_through_parameters(node, ctx.file, ctx.checker) {
            ctx.report_node(
                matched.name_node,
                build_pass_through_message(&matched.name, &matched.targets),
            );
        }
    }
}
