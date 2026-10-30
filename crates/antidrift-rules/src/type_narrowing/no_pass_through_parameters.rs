use antidrift_kernel::callgraph;
use antidrift_kernel::file_role;
use antidrift_kernel::rule_scope::RuleScope;
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

pub struct NoPassThroughParameters {
    scope: RuleScope,
}

impl NoPassThroughParameters {
    pub const DEFAULT: Self = Self {
        scope: RuleScope::DEFAULT,
    };
}

pub static DEFAULT_INSTANCE: NoPassThroughParameters = NoPassThroughParameters::DEFAULT;

pub fn create(options: Option<&serde_json::Value>) -> Result<Box<dyn Rule>, String> {
    Ok(Box::new(NoPassThroughParameters {
        scope: RuleScope::from_options(RULE_NAME, options)?,
    }))
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

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let file_name = ctx.file.file_name();
        let enabled = self.scope.matches(file_name, cwd)
            && !self.scope.skips_generated(
                &file_role::ProjectPath::of(ctx.program, file_name),
                ctx.file.text(),
            );
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
        for matched in callgraph::find_pass_through_parameters(node, ctx.file, ctx.checker) {
            ctx.report_node(
                matched.name_node,
                build_pass_through_message(&matched.name, &matched.targets),
            );
        }
    }
}
