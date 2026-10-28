use antidrift_kernel::jsx::{
    attribute_initializer_expression, is_jsx_element_like, jsx_attributes_list,
    plain_attribute_name, plain_element_name,
};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::unwrap_parentheses;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-portal-under-interactive-ancestor";
const WATCHED_HANDLERS: [&str; 9] = [
    "onMouseDown",
    "onMouseUp",
    "onClick",
    "onContextMenu",
    "onPointerDown",
    "onPointerUp",
    "onFocus",
    "onTouchStart",
    "onTouchEnd",
];
const PORTAL_POPUPS: [&str; 8] = [
    "ComboboxPopup",
    "DialogContent",
    "DialogPopup",
    "MenuPopup",
    "PopoverContent",
    "PopoverPanel",
    "PopoverPopup",
    "TooltipPopup",
];
const INTERACTIVE_ELEMENTS: [&str; 4] = ["a", "button", "Button", "Link"];
const HELPER_NAMES: [&str; 2] = ["containedEventHandler", "containedHandler"];

pub struct NoPortalUnderInteractiveAncestor {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoPortalUnderInteractiveAncestor = NoPortalUnderInteractiveAncestor {
    scope: RuleScope::DEFAULT,
};

impl NoPortalUnderInteractiveAncestor {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxOpeningElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];

impl Rule for NoPortalUnderInteractiveAncestor {
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
        let Some(popup) = plain_element_name(node).filter(|name| PORTAL_POPUPS.contains(name))
        else {
            return;
        };
        let element = if node.kind() == Kind::JsxOpeningElement {
            node.parent().unwrap_or(node)
        } else {
            node
        };
        let Some(ancestor) = interactive_ancestor_name(element) else {
            return;
        };
        ctx.report_node(
            node,
            RuleMessage::new(
                "portalUnderInteractive",
                format!(
                    "`<{popup}>` portals its events through the React tree but is nested under interactive `<{ancestor}>`. Hoist the popup/root outside that interactive subtree so popup events cannot trigger navigation or parent actions."
                ),
            ),
        );
    }
}

fn is_safe_handler_value(expression: P<Node>) -> bool {
    let inner = unwrap_parentheses(expression);
    match inner.kind() {
        Kind::Identifier => inner.as_identifier().text() == "undefined",
        Kind::NullKeyword => true,
        Kind::CallExpression => {
            let callee = inner.as_call_expression().expression();
            ast::is_identifier(callee) && HELPER_NAMES.contains(&callee.as_identifier().text())
        }
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            is_safe_handler_value(cond.when_true()) && is_safe_handler_value(cond.when_false())
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            matches!(
                bin.operator_token().kind(),
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken
            ) && is_safe_handler_value(bin.left())
                && is_safe_handler_value(bin.right())
        }
        _ => false,
    }
}

fn is_safe_handler(attribute: P<Node>) -> bool {
    let Some(init) = attribute.as_jsx_attribute().initializer() else {
        return true;
    };
    if init.kind() != Kind::JsxExpression {
        return true;
    }
    attribute_initializer_expression(attribute).is_some_and(is_safe_handler_value)
}

fn has_interactive_handler(element: P<Node>) -> bool {
    jsx_attributes_list(element).iter().copied().any(|attr| {
        plain_attribute_name(attr).is_some_and(|name| WATCHED_HANDLERS.contains(&name))
            && !is_safe_handler(attr)
    })
}

fn interactive_ancestor_name(element: P<Node>) -> Option<&'static str> {
    let mut cursor = element.parent();
    while let Some(ancestor) = cursor {
        if is_jsx_element_like(ancestor)
            && let Some(name) = plain_element_name(ancestor)
            && (INTERACTIVE_ELEMENTS.contains(&name) || has_interactive_handler(ancestor))
        {
            return Some(name);
        }
        cursor = ancestor.parent();
    }
    None
}
