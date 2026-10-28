use antidrift_kernel::{boundary, tsrs_kernel};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-schema-validator-transcoding";

pub struct NoSchemaValidatorTranscoding;

pub static DEFAULT_RULE: NoSchemaValidatorTranscoding = NoSchemaValidatorTranscoding;

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoSchemaValidatorTranscoding {
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
        if boundary::is_openapi_documentation_call(ctx.checker, node) {
            return;
        }
        if !boundary::is_convex_registrar_call(ctx.checker, node) {
            return;
        }
        let Some(&first_arg) = node.as_call_expression().arguments().nodes().first() else {
            return;
        };
        let config_node = tsrs_kernel::unwrap_expression(first_arg);
        if config_node.kind() != Kind::ObjectLiteralExpression {
            return;
        }
        for &prop in config_node
            .as_object_literal_expression()
            .properties()
            .nodes()
        {
            NoSchemaValidatorTranscoding::check_property(prop, ctx);
        }
    }
}

impl NoSchemaValidatorTranscoding {
    fn check_property(prop: P<Node>, ctx: &mut Ctx) {
        if prop.kind() != Kind::PropertyAssignment {
            return;
        }
        let assignment = prop.as_property_assignment();
        let Some(key_name) = tsrs_kernel::property_name_text(assignment.name()) else {
            return;
        };
        if !matches!(key_name.as_str(), "args" | "returns") {
            return;
        }
        if boundary::is_json_schema_conversion_result(ctx.checker, assignment.initializer(), 4) {
            ctx.report_node(
                assignment.initializer(),
                RuleMessage::new(
                    "no-schema-validator-transcoding",
                    "Do not transcode an Effect Schema or Zod schema into a Convex validator via JSONSchema.make(...) or toJSONSchema(...); keep one canonical boundary validator owner.",
                ),
            );
        }
    }
}
