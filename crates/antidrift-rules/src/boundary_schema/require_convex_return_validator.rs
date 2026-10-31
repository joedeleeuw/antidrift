use antidrift_kernel::{boundary, tsrs_kernel};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-convex-return-validator";

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum AllowedEntry {
    Name(String),
    Spec(AllowedFunctionSpec),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AllowedFunctionSpec {
    function: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct ConvexValidatorOptions {
    allows: Vec<AllowedEntry>,
}

pub struct RequireConvexReturnValidator {
    allows: FxHashSet<String>,
}

pub static DEFAULT_RULE: RequireConvexReturnValidator = RequireConvexReturnValidator {
    allows: FxHashSet::with_hasher(rustc_hash::FxBuildHasher),
};

impl RequireConvexReturnValidator {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let parsed = super::decode_rule_options::<ConvexValidatorOptions>(RULE_NAME, options)?;
        let mut allows = FxHashSet::default();
        for entry in parsed.allows {
            let name = match entry {
                AllowedEntry::Name(val) => val,
                AllowedEntry::Spec(spec) => spec.function,
            };
            if name.trim().is_empty() {
                return Err(format!(
                    "invalid options for {RULE_NAME}: allows entry must not be empty"
                ));
            }
            allows.insert(name);
        }
        Ok(Self { allows })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

struct RegistrationInspection {
    has_dynamic: bool,
    has_handler: bool,
    returns_initializer: Option<P<Node>>,
}

impl Rule for RequireConvexReturnValidator {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor { rule: self })
    }
}

struct Visitor {
    rule: &'static RequireConvexReturnValidator,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
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
        let inspection = RequireConvexReturnValidator::inspect_registration_config(config_node);
        if !inspection.has_handler {
            return;
        }
        let def_name =
            RequireConvexReturnValidator::convex_definition_name(node).unwrap_or("this handler");
        if let Some(returns_init) = inspection.returns_initializer {
            if !self.rule.allows.contains(def_name)
                && boundary::contains_convex_any(ctx.checker, returns_init)
            {
                ctx.report_node(
                    returns_init,
                    RuleMessage::new(
                        "require-convex-return-validator",
                        format!(
                            "Convex registration '{def_name}' must declare an explicit `returns` validator (`v.null()` for void functions), and `returns` must not use `v.any()`."
                        ),
                    ),
                );
            }
            return;
        }
        if inspection.has_dynamic {
            return;
        }
        ctx.report_node(
            config_node,
            RuleMessage::new(
                "require-convex-return-validator",
                format!(
                    "Convex registration '{def_name}' must declare an explicit `returns` validator (`v.null()` for void functions), and `returns` must not use `v.any()`."
                ),
            ),
        );
    }
}

impl RequireConvexReturnValidator {
    fn inspect_registration_config(config_node: P<Node>) -> RegistrationInspection {
        let mut inspection = RegistrationInspection {
            has_dynamic: false,
            has_handler: false,
            returns_initializer: None,
        };
        for &prop in config_node
            .as_object_literal_expression()
            .properties()
            .nodes()
        {
            Self::inspect_property(prop, &mut inspection);
        }
        inspection
    }

    fn inspect_property(prop: P<Node>, inspection: &mut RegistrationInspection) {
        match prop.kind() {
            Kind::PropertyAssignment => {
                let assign = prop.as_property_assignment();
                let Some(key_name) = tsrs_kernel::property_name_text(assign.name()) else {
                    inspection.has_dynamic = true;
                    return;
                };
                Self::record_named_property(key_name, assign.initializer(), inspection);
            }
            Kind::ShorthandPropertyAssignment => {
                let name = prop.as_shorthand_property_assignment().name();
                if ast::is_identifier(name) {
                    Self::record_named_property(name.as_identifier().text(), name, inspection);
                }
            }
            Kind::MethodDeclaration => {
                if prop.name().and_then(tsrs_kernel::property_name_text) == Some("handler") {
                    inspection.has_handler = true;
                }
            }
            _ => {
                inspection.has_dynamic = true;
            }
        }
    }

    fn record_named_property(
        key_name: &str,
        initializer: P<Node>,
        inspection: &mut RegistrationInspection,
    ) {
        if key_name == "handler" {
            inspection.has_handler = true;
        } else if key_name == "returns" {
            inspection.returns_initializer = Some(initializer);
        }
    }

    fn convex_definition_name(node: P<Node>) -> Option<&'static str> {
        let mut current = node.parent();
        while let Some(curr) = current {
            if tsrs_kernel::is_function_like(curr) {
                break;
            }
            if let Some(name) = Self::definition_name_at_ancestor(curr) {
                return Some(name);
            }
            current = curr.parent();
        }
        None
    }

    fn definition_name_at_ancestor(curr: P<Node>) -> Option<&'static str> {
        match curr.kind() {
            Kind::VariableDeclaration => {
                let name = curr.as_variable_declaration().name();
                ast::is_identifier(name).then(|| name.as_identifier().text())
            }
            Kind::PropertyAssignment => {
                tsrs_kernel::property_name_text(curr.as_property_assignment().name())
            }
            Kind::ExportAssignment => Some("default"),
            _ => None,
        }
    }
}
