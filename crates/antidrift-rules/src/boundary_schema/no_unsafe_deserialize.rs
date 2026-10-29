use antidrift_kernel::boundary;
use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unsafe-deserialize";

pub struct NoUnsafeDeserialize {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoUnsafeDeserialize = NoUnsafeDeserialize {
    scope: RuleScope::DEFAULT,
};

impl NoUnsafeDeserialize {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::Identifier),
];

impl Rule for NoUnsafeDeserialize {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !self.scope.in_scope(ctx) {
            return Box::new(EmptyVisitor);
        }
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if boundary::is_json_stringify_roundtrip(ctx.checker, node) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "valueSerializationRoundtrip",
                    "Do not round-trip in-memory values through `JSON.stringify(...)` and `JSON.parse(...)`; clone with `structuredClone(...)` or key by a structured tuple/value.",
                ),
            );
            return;
        }
        let target = boundary::parsed_json_target(Some(ctx.program), ctx.checker, node);
        if !target.is_empty() {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "no-unsafe-deserialize",
                    format!(
                        "Validate parsed JSON against the schema for '{target}', not with an unchecked type annotation or cast."
                    ),
                ),
            );
            return;
        }
        if boundary::is_unsafe_json_parse_input(ctx.checker, node) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "no-unsafe-deserialize",
                    "Do not pass `any` or `unknown` directly into `JSON.parse(...)`; prove or decode the string input first.",
                ),
            );
        }
    }
}
