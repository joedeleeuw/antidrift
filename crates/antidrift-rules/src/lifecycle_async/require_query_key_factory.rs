use super::syntax::{
    const_initializer, identifier, in_scope, member, object_property, property_name, symbol, unwrap,
};
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-query-key-factory";

pub struct RequireQueryKeyFactory {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireQueryKeyFactory = RequireQueryKeyFactory {
    scope: RuleScope::DEFAULT,
};

impl RequireQueryKeyFactory {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::CallExpression),
    Listener::Enter(Kind::BinaryExpression),
];

impl Rule for RequireQueryKeyFactory {
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
            Kind::CallExpression => inspect_call(ctx, node),
            Kind::BinaryExpression => {
                let bin = node.as_binary_expression();
                if matches!(
                    bin.operator_token().kind(),
                    Kind::EqualsEqualsEqualsToken | Kind::ExclamationEqualsEqualsToken
                ) && (key_position(bin.left()) || key_position(bin.right()))
                    && inside_predicate_property(node)
                {
                    ctx.report_node(
                        node,
                        RuleMessage::new(
                            "inlinePredicate",
                            "Match the key with a named helper exported next to the factory (for example `matchesChatThread(query.queryKey, threadRef)`), not with inline key-position comparisons that restate the factory's layout where nothing checks it.",
                        ),
                    );
                }
            }
            _ => {}
        }
    }
}

fn inside_predicate_property(node: P<Node>) -> bool {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if let Some((key, _, _)) = object_property(ancestor)
            && property_name(key) == Some("predicate")
        {
            return true;
        }
        cursor = ancestor.parent();
    }
    false
}

fn inspect_call(ctx: &mut Ctx<'_>, call_node: P<Node>) {
    let call = call_node.as_call_expression();
    let callee = unwrap(call.expression());
    if callee.kind() != Kind::PropertyAccessExpression {
        return;
    }
    let name_node = callee.as_property_access_expression().name();
    if !ast::is_identifier(name_node) {
        return;
    }
    let method = name_node.as_identifier().text();
    if ![
        "invalidateQueries",
        "setQueryData",
        "removeQueries",
        "cancelQueries",
    ]
    .contains(&method)
    {
        return;
    }
    let args = call.arguments().nodes();
    if method == "setQueryData"
        && let Some(&key) = args.first()
        && key.kind() != Kind::SpreadElement
    {
        report_array(ctx, key);
    }
    for &argument in args {
        if argument.kind() != Kind::SpreadElement {
            inspect_options(ctx, argument);
        }
    }
}

fn inspect_options(ctx: &mut Ctx<'_>, expression: P<Node>) {
    let mut expression = unwrap(expression);
    if let Some(ident) = identifier(expression) {
        let Some(binding) = symbol(ident) else {
            return;
        };
        if binding.is_top_level() {
            return;
        }
        let Some(initializer) = const_initializer(binding) else {
            return;
        };
        expression = unwrap(initializer);
    }
    if expression.kind() != Kind::ObjectLiteralExpression {
        return;
    }
    for &prop in expression
        .as_object_literal_expression()
        .properties()
        .nodes()
    {
        if let Some((key, value, _)) = object_property(prop)
            && property_name(key) == Some("queryKey")
        {
            report_array(ctx, value);
        }
    }
}

fn report_array(ctx: &mut Ctx<'_>, expression: P<Node>) {
    let inner = unwrap(expression);
    if inner.kind() == Kind::ArrayLiteralExpression {
        ctx.report_node(
            inner,
            RuleMessage::new(
                "inlineQueryKey",
                "Pass a query-key factory call here, not an inline array. A hand-typed key silently stops matching when the factory's shape changes (QueryKey is unknown[]), leaving the cache stale.",
            ),
        );
    }
}

fn query_key(expression: P<Node>) -> bool {
    identifier(expression).is_some_and(|ident| ident.as_identifier().text() == "queryKey") || {
        let inner = unwrap(expression);
        inner.kind() == Kind::PropertyAccessExpression && {
            let name = inner.as_property_access_expression().name();
            ast::is_identifier(name) && name.as_identifier().text() == "queryKey"
        }
    }
}

fn numeric(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::NumericLiteral => true,
        Kind::PrefixUnaryExpression => {
            let unary = inner.as_prefix_unary_expression();
            unary.operator() == Kind::MinusToken && numeric(unary.operand())
        }
        _ => false,
    }
}

fn key_position(expression: P<Node>) -> bool {
    let inner = unwrap(expression);
    match inner.kind() {
        Kind::ElementAccessExpression => {
            let access = inner.as_element_access_expression();
            query_key(access.expression()) && numeric(access.argument_expression())
        }
        Kind::CallExpression => {
            let call = inner.as_call_expression();
            let args = call.arguments().nodes();
            member(call.expression()).is_some_and(|(object, method)| {
                method == "at"
                    && unwrap(call.expression()).kind() == Kind::PropertyAccessExpression
                    && query_key(object)
                    && args.len() == 1
                    && args[0].kind() != Kind::SpreadElement
                    && numeric(args[0])
            })
        }
        _ => false,
    }
}
