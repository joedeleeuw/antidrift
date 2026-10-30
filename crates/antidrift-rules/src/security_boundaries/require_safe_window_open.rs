use super::web_provenance::{
    AliasStability, const_initializer, member_expression, member_object, resolve_lexical_binding,
    static_property_name, unwrap_expression,
};
use antidrift_kernel::local_binding::Binding;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::cooked_text;
use tsrs_ast::{Kind, Node, SourceFile};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/require-safe-window-open";

pub struct RequireSafeWindowOpen {
    scope: RuleScope,
}

pub static DEFAULT_RULE: RequireSafeWindowOpen = RequireSafeWindowOpen {
    scope: RuleScope::DEFAULT,
};

impl RequireSafeWindowOpen {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for RequireSafeWindowOpen {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
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
        let call = node.as_call_expression();
        let third_arg = call
            .arguments()
            .nodes()
            .get(2)
            .copied()
            .filter(|arg| arg.kind() != Kind::SpreadElement);
        if !browser_open(ctx.file, call.expression()) || safe_features(third_arg) {
            return;
        }
        ctx.report_node(
            node,
            RuleMessage::new(
                "requireSafeWindowOpen",
                "Pass noopener,noreferrer in the third argument to window.open() so the browser isolates the opener.",
            ),
        );
    }
}

fn browser_open(sf: P<SourceFile>, expression: P<Node>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        return expression.as_identifier().text() == "open"
            && resolve_lexical_binding(expression).is_none();
    }
    member_expression(expression).is_some_and(|member| {
        static_property_name(member) == Some("open")
            && browser_global(sf, member_object(member), &mut Vec::new())
    })
}

fn browser_global(sf: P<SourceFile>, expression: P<Node>, visited: &mut Vec<Binding>) -> bool {
    let expression = unwrap_expression(expression);
    if expression.kind() == Kind::Identifier {
        let symbol = resolve_lexical_binding(expression);
        if matches!(
            expression.as_identifier().text(),
            "window" | "globalThis" | "self"
        ) && symbol.is_none()
        {
            return true;
        }
        let Some(symbol) = symbol else {
            return false;
        };
        if visited.contains(&symbol) {
            return false;
        }
        visited.push(symbol);
        return const_initializer(sf, symbol, AliasStability::Unwritten)
            .is_some_and(|initializer| browser_global(sf, initializer, visited));
    }
    member_expression(expression).is_some_and(|member| {
        static_property_name(member) == Some("window")
            && browser_global(sf, member_object(member), visited)
    })
}

fn safe_features(features: Option<P<Node>>) -> bool {
    let Some(features) = features else {
        return false;
    };
    if features.kind() != Kind::StringLiteral {
        return false;
    }
    let Some(text) = cooked_text(features) else {
        return false;
    };
    ["noopener", "noreferrer"].iter().all(|required| {
        text.split(',').any(|segment| {
            segment
                .trim_start()
                .strip_prefix(required)
                .is_some_and(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
        })
    })
}
