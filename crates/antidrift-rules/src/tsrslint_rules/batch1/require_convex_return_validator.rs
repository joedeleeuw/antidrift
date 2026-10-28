use antidrift_kernel::{boundary, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-convex-return-validator";

pub struct RequireConvexReturnValidator {
    allows: FxHashSet<String>,
}

pub static DEFAULT_RULE: RequireConvexReturnValidator = RequireConvexReturnValidator {
    allows: FxHashSet::with_hasher(rustc_hash::FxBuildHasher),
};

impl RequireConvexReturnValidator {
    #[must_use]
    pub fn from_options(options: Option<&serde_json::Value>) -> Self {
        let mut allows = FxHashSet::default();
        let Some(arr) = Self::extract_allows_array(options) else {
            return Self { allows };
        };
        for item in arr {
            if let Some(name) = Self::extract_allowed_name(item) {
                allows.insert(name.to_string());
            }
        }
        Self { allows }
    }

    fn extract_allows_array(
        options: Option<&serde_json::Value>,
    ) -> Option<&Vec<serde_json::Value>> {
        let val = options?;
        let obj = val
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(serde_json::Value::as_object)
            .or_else(|| val.as_object())?;
        obj.get("allows")?.as_array()
    }

    fn extract_allowed_name(item: &serde_json::Value) -> Option<&str> {
        let name = item.as_str().or_else(|| {
            item.as_object()
                .and_then(|obj| obj.get("function"))
                .and_then(serde_json::Value::as_str)
        })?;
        (!name.is_empty()).then_some(name)
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
        let def_name = RequireConvexReturnValidator::convex_definition_name(node)
            .unwrap_or_else(|| "this handler".to_string());
        if let Some(returns_init) = inspection.returns_initializer {
            if !self.rule.allows.contains(&def_name)
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
                Self::record_named_property(&key_name, assign.initializer(), inspection);
            }
            Kind::ShorthandPropertyAssignment => {
                let name = prop.as_shorthand_property_assignment().name();
                if ast::is_identifier(name) {
                    Self::record_named_property(name.as_identifier().text(), name, inspection);
                }
            }
            Kind::MethodDeclaration => {
                if prop
                    .name()
                    .and_then(tsrs_kernel::property_name_text)
                    .as_deref()
                    == Some("handler")
                {
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

    fn convex_definition_name(node: P<Node>) -> Option<String> {
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

    fn definition_name_at_ancestor(curr: P<Node>) -> Option<String> {
        match curr.kind() {
            Kind::VariableDeclaration => {
                let name = curr.as_variable_declaration().name();
                ast::is_identifier(name).then(|| name.as_identifier().text().to_string())
            }
            Kind::PropertyAssignment => {
                tsrs_kernel::property_name_text(curr.as_property_assignment().name())
            }
            Kind::ExportAssignment => Some("default".to_string()),
            _ => None,
        }
    }
}
