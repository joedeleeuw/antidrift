use super::syntax::{
    Span, binding_for_declarator, call_expression, const_initializer, identifier, in_scope,
    object_property, parent_expression, property_name, root_identifier, symbol, unwrap,
};
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-spread-input-in-query-key";

pub struct NoSpreadInputInQueryKey {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoSpreadInputInQueryKey = NoSpreadInputInQueryKey {
    scope: RuleScope::DEFAULT,
};

impl NoSpreadInputInQueryKey {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::PropertyAssignment),
    Listener::Enter(Kind::ShorthandPropertyAssignment),
    Listener::Enter(Kind::ArrayLiteralExpression),
    Listener::Enter(Kind::CallExpression),
];

impl Rule for NoSpreadInputInQueryKey {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor {
            enabled: in_scope(ctx, &self.scope),
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
        match node.kind() {
            Kind::PropertyAssignment | Kind::ShorthandPropertyAssignment => {
                if let Some((key, value, _)) = object_property(node)
                    && property_name(key) == Some("queryKey")
                {
                    report_key(ctx, value);
                }
            }
            Kind::ArrayLiteralExpression if factory_return(node) => {
                for &element in node.as_array_literal_expression().elements().nodes() {
                    report_element(ctx, element);
                }
            }
            Kind::CallExpression => {
                let call = node.as_call_expression();
                if identifier(call.expression()).is_some_and(|callee| {
                    ["useSWR", "useSWRImmutable", "useSWRMutation"]
                        .contains(&callee.as_identifier().text())
                }) && let Some(&key) = call.arguments().nodes().first()
                    && key.kind() != Kind::SpreadElement
                {
                    report_key(ctx, key);
                }
            }
            _ => {}
        }
    }
}

fn report_key(ctx: &mut Ctx<'_>, expression: P<Node>) {
    let mut expression = unwrap(expression);
    if let Some(ident) = identifier(expression) {
        let Some(binding) = symbol(ident) else {
            return;
        };
        let Some(initializer) = const_initializer(binding) else {
            return;
        };
        if binding.range(ctx.file).0 >= Span::of(ctx.file, ident).start {
            return;
        }
        expression = initializer;
    }
    report_expression(ctx, expression);
}

fn composition(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    if let Some(call) = call_expression(inner) {
        return composition(call.as_call_expression().expression());
    }
    let is_member = matches!(
        inner.kind(),
        Kind::PropertyAccessExpression | Kind::ElementAccessExpression
    );
    is_member
        && root_identifier(inner).is_some_and(|root| root.as_identifier().text().ends_with("Keys"))
}

fn explicit_object(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::ObjectLiteralExpression => inner
            .as_object_literal_expression()
            .properties()
            .nodes()
            .iter()
            .all(|&prop| match prop.kind() {
                Kind::SpreadAssignment => explicit_object(prop.as_spread_assignment().expression()),
                _ => object_property(prop).is_some_and(|(_, _, computed)| !computed),
            }),
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            bin.operator_token().kind() == Kind::AmpersandAmpersandToken
                && explicit_object(bin.right())
        }
        Kind::ConditionalExpression => {
            let conditional = inner.as_conditional_expression();
            explicit_object(conditional.when_true()) && explicit_object(conditional.when_false())
        }
        _ => false,
    }
}

fn report_element(ctx: &mut Ctx<'_>, element: P<Node>) {
    match element.kind() {
        Kind::SpreadElement => {
            if !composition(element.as_spread_element().expression()) {
                report_spread(ctx, element);
            }
        }
        Kind::OmittedExpression => {}
        _ => report_expression(ctx, element),
    }
}

fn report_expression(ctx: &mut Ctx<'_>, expression: P<Node>) {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            if bin.operator_token().kind() == Kind::AmpersandAmpersandToken {
                report_expression(ctx, bin.right());
            }
        }
        Kind::ConditionalExpression => {
            let conditional = inner.as_conditional_expression();
            report_expression(ctx, conditional.when_true());
            report_expression(ctx, conditional.when_false());
        }
        Kind::ArrayLiteralExpression => {
            for &element in inner.as_array_literal_expression().elements().nodes() {
                report_element(ctx, element);
            }
        }
        Kind::ObjectLiteralExpression => {
            for &prop in inner.as_object_literal_expression().properties().nodes() {
                report_object_property(ctx, prop);
            }
        }
        _ => {}
    }
}

fn report_object_property(ctx: &mut Ctx<'_>, prop: P<Node>) {
    if prop.kind() == Kind::SpreadAssignment {
        let arg = prop.as_spread_assignment().expression();
        if !explicit_object(arg) {
            report_spread(ctx, prop);
        } else {
            report_expression(ctx, arg);
        }
    } else if let Some((_, value, _)) = object_property(prop) {
        report_expression(ctx, value);
    }
}

fn report_spread(ctx: &mut Ctx<'_>, node: P<Node>) {
    ctx.report_node(
        node,
        RuleMessage::new(
            "spreadInputInQueryKey",
            "Do not spread a bare input object into a query key. Spreading leaks every property of the source into the cache identity (spurious refetches, stale reads, unbounded cache growth). Spread a `*Keys` composition call (`...entitiesKeys.all(ws)`) and list concrete cache-identity fields explicitly instead.",
        ),
    );
}

fn factory_return(node: P<Node>) -> bool {
    let Some(mut parent) = parent_expression(node).parent() else {
        return false;
    };
    if parent.kind() == Kind::ConditionalExpression {
        let Some(next) = parent_expression(parent).parent() else {
            return false;
        };
        parent = next;
    }
    if parent.kind() == Kind::ReturnStatement {
        let Some(mut block) = parent.parent() else {
            return false;
        };
        while block.kind() == Kind::Block {
            let Some(next) = block.parent() else {
                return false;
            };
            block = next;
        }
        parent = block;
    }
    if parent.kind() != Kind::ArrowFunction {
        return false;
    }
    let Some(prop) = parent.parent() else {
        return false;
    };
    if !matches!(
        prop.kind(),
        Kind::PropertyAssignment | Kind::ShorthandPropertyAssignment
    ) {
        return false;
    }
    let Some(mut obj) = prop.parent() else {
        return false;
    };
    while obj.kind() == Kind::ObjectLiteralExpression {
        let Some(container) = parent_expression(obj).parent() else {
            return false;
        };
        match container.kind() {
            Kind::VariableDeclaration => {
                return binding_for_declarator(container)
                    .is_some_and(|binding| binding.name().ends_with("Keys"));
            }
            Kind::PropertyAssignment | Kind::ShorthandPropertyAssignment => {
                let Some(next_obj) = container.parent() else {
                    return false;
                };
                obj = next_obj;
            }
            _ => return false,
        }
    }
    false
}
