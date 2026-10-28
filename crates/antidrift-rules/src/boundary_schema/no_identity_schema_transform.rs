use antidrift_kernel::rule_scope::{EmptyVisitor, RuleScope};
use antidrift_kernel::{boundary, tsrs_kernel};
use rustc_hash::FxHashSet;
use tsrs_ast::{self as ast, Kind, Node, NodeFlags};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-identity-schema-transform";

pub struct NoIdentitySchemaTransform {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoIdentitySchemaTransform = NoIdentitySchemaTransform {
    scope: RuleScope::DEFAULT,
};

impl NoIdentitySchemaTransform {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoIdentitySchemaTransform {
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
        let Some(parts) = boundary::zod_transform_call_parts(node, ctx.checker) else {
            return;
        };
        if NoIdentitySchemaTransform::is_direct_identity_callback(parts.callback_node) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "no-identity-schema-transform",
                    "This Zod transform returns its input unchanged. Remove the identity transform and infer the schema output directly.",
                ),
            );
            return;
        }
        let Some(returned_keys) =
            NoIdentitySchemaTransform::returned_identity_keys(parts.callback_node)
        else {
            return;
        };
        let input_keys =
            boundary::closed_zod_transform_input_keys(parts.receiver_node, ctx.checker);
        if input_keys.is_empty() || input_keys.len() != returned_keys.len() {
            return;
        }
        if input_keys.iter().any(|key| !returned_keys.contains(key)) {
            return;
        }
        ctx.report_node(
            parts.callback_node,
            RuleMessage::new(
                "no-identity-schema-transform",
                "This Zod transform returns its input unchanged. Remove the identity transform and infer the schema output directly.",
            ),
        );
    }
}

impl NoIdentitySchemaTransform {
    fn is_direct_identity_callback(callback: P<Node>) -> bool {
        let &[param_node] = callback.parameters() else {
            return false;
        };
        let param = param_node.as_parameter_declaration();
        if param.dot_dot_dot_token().is_some() || param.initializer().is_some() {
            return false;
        }
        let param_name = param.name();
        if !ast::is_identifier(param_name) {
            return false;
        }
        let Some(returned_expr) = Self::returned_expression(callback) else {
            return false;
        };
        ast::is_identifier(returned_expr)
            && returned_expr.as_identifier().text() == param_name.as_identifier().text()
    }

    fn returned_expression(callback: P<Node>) -> Option<P<Node>> {
        let body = tsrs_kernel::function_body_node(callback)?;
        let expr = if body.kind() == Kind::Block {
            let statements = body.as_block().statements().nodes();
            if statements.len() != 1 || statements[0].kind() != Kind::ReturnStatement {
                return None;
            }
            statements[0].as_return_statement().expression()?
        } else {
            body
        };
        Some(tsrs_kernel::unwrap_expression(expr))
    }

    fn returned_identity_keys(callback: P<Node>) -> Option<FxHashSet<String>> {
        let &[param_node] = callback.parameters() else {
            return None;
        };
        let param = param_node.as_parameter_declaration();
        if param.dot_dot_dot_token().is_some() || param.initializer().is_some() {
            return None;
        }
        let returned = Self::returned_object_literal(callback)?;
        let param_name = param.name();
        if ast::is_identifier(param_name) {
            return Self::keys_from_identifier_param(param_name.as_identifier().text(), returned);
        }
        if param_name.kind() == Kind::ObjectBindingPattern {
            return Self::keys_from_binding_pattern(param_name, returned);
        }
        None
    }

    fn returned_object_literal(callback: P<Node>) -> Option<P<Node>> {
        let body = tsrs_kernel::function_body_node(callback)?;
        let expr = if body.kind() == Kind::Block {
            let statements = body.as_block().statements().nodes();
            if statements.len() != 1 || statements[0].kind() != Kind::ReturnStatement {
                return None;
            }
            statements[0].as_return_statement().expression()?
        } else {
            body
        };
        let unwrapped = tsrs_kernel::unwrap_expression(expr);
        (unwrapped.kind() == Kind::ObjectLiteralExpression).then_some(unwrapped)
    }

    fn keys_from_identifier_param(param_name: &str, obj: P<Node>) -> Option<FxHashSet<String>> {
        let props = obj.as_object_literal_expression().properties().nodes();
        if props.is_empty() {
            return None;
        }
        let mut keys = FxHashSet::default();
        for &prop in props {
            let key = Self::matching_member_property(prop, param_name)?;
            if !keys.insert(key) {
                return None;
            }
        }
        Some(keys)
    }

    fn matching_member_property(prop: P<Node>, param_name: &str) -> Option<String> {
        if prop.kind() != Kind::PropertyAssignment {
            return None;
        }
        let assign = prop.as_property_assignment();
        let name_node = assign.name();
        if !ast::is_identifier(name_node) {
            return None;
        }
        let key = name_node.as_identifier().text();
        let value = tsrs_kernel::unwrap_expression(assign.initializer());
        if value.kind() != Kind::PropertyAccessExpression
            || value.flags().intersects(NodeFlags::OptionalChain)
        {
            return None;
        }
        let member = value.as_property_access_expression();
        let receiver = tsrs_kernel::unwrap_expression(member.expression());
        let prop_id = member.name();
        if !ast::is_identifier(receiver)
            || receiver.as_identifier().text() != param_name
            || !ast::is_identifier(prop_id)
            || prop_id.as_identifier().text() != key
        {
            return None;
        }
        Some(key.to_string())
    }

    fn keys_from_binding_pattern(pattern: P<Node>, obj: P<Node>) -> Option<FxHashSet<String>> {
        let elements = pattern.as_binding_pattern().elements().nodes();
        let props = obj.as_object_literal_expression().properties().nodes();
        if elements.is_empty() || elements.len() != props.len() {
            return None;
        }
        let mut param_keys = FxHashSet::default();
        for &elem_node in elements {
            let key = Self::extract_binding_element_key(elem_node)?;
            if !param_keys.insert(key) {
                return None;
            }
        }
        let mut returned_keys = FxHashSet::default();
        for &prop in props {
            let key = Self::matching_destructured_property(prop)?;
            if !param_keys.contains(&key) || !returned_keys.insert(key) {
                return None;
            }
        }
        Some(returned_keys)
    }

    fn extract_binding_element_key(elem_node: P<Node>) -> Option<String> {
        let elem = elem_node.as_binding_element();
        if elem.dot_dot_dot_token().is_some() || elem.initializer().is_some() {
            return None;
        }
        let local = elem.name()?;
        if !ast::is_identifier(local) {
            return None;
        }
        let local_name = local.as_identifier().text();
        if let Some(prop_name) = elem.property_name()
            && (!ast::is_identifier(prop_name) || prop_name.as_identifier().text() != local_name)
        {
            return None;
        }
        Some(local_name.to_string())
    }

    fn matching_destructured_property(prop: P<Node>) -> Option<String> {
        match prop.kind() {
            Kind::ShorthandPropertyAssignment => {
                let name = prop.as_shorthand_property_assignment().name();
                ast::is_identifier(name).then(|| name.as_identifier().text().to_string())
            }
            Kind::PropertyAssignment => {
                let assign = prop.as_property_assignment();
                let name_node = assign.name();
                let value_node = tsrs_kernel::unwrap_expression(assign.initializer());
                if !ast::is_identifier(name_node) || !ast::is_identifier(value_node) {
                    return None;
                }
                let key = name_node.as_identifier().text();
                (value_node.as_identifier().text() == key).then(|| key.to_string())
            }
            _ => None,
        }
    }
}
