use antidrift_kernel::jsx::{
    attribute_name, element_tag_name, find_attribute, is_jsx_element_like, jsx_attributes_list,
    jsx_children, render_prop_element, static_attribute_string,
};
use antidrift_kernel::rule_scope::{
    RuleScope, ScopeOptions, ScopedOptions, decode_scoped, in_scope,
};
use antidrift_kernel::tsrs_kernel::{cooked_text, unwrap_expression, unwrap_parentheses};
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/icon-button-requires-tooltip";
const INTERACTIVE_ELEMENTS: [&str; 10] = [
    "AlertDialogClose",
    "AlertDialogTrigger",
    "Button",
    "DialogClose",
    "DialogTrigger",
    "MenuTrigger",
    "PopoverTrigger",
    "SheetClose",
    "SheetTrigger",
    "button",
];
const AUTO_TOOLTIP_ELEMENTS: [&str; 9] = [
    "AlertDialogClose",
    "AlertDialogTrigger",
    "Button",
    "DialogClose",
    "DialogTrigger",
    "MenuTrigger",
    "PopoverTrigger",
    "SheetClose",
    "SheetTrigger",
];
const TOOLTIP_ELEMENTS: [&str; 2] = ["Tooltip", "TooltipRoot"];
const TOOLTIP_ATTRIBUTES: [&str; 1] = ["tooltip"];
const AUTO_TOOLTIP_ATTRIBUTES: [&str; 2] = ["aria-label", "title"];
const NATIVE_TOOLTIP_ATTRIBUTES: [&str; 1] = ["title"];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct IconTooltipOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    icon_components: Vec<String>,
}

impl ScopedOptions for IconTooltipOptions {
    fn scope(&self) -> ScopeOptions {
        self.scope.clone()
    }
}

pub struct IconButtonRequiresTooltip {
    scope: RuleScope,
    icon_components: Vec<String>,
}

pub static DEFAULT_RULE: IconButtonRequiresTooltip = IconButtonRequiresTooltip {
    scope: RuleScope::DEFAULT,
    icon_components: Vec::new(),
};

impl IconButtonRequiresTooltip {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let (parsed, scope) = decode_scoped::<IconTooltipOptions>(RULE_NAME, options)?;
        Ok(Self {
            scope,
            icon_components: parsed.icon_components,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];

impl Rule for IconButtonRequiresTooltip {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = ctx.file.file_name().ends_with(".tsx") && in_scope(&self.scope, ctx, None);
        Box::new(Visitor {
            rule: self,
            enabled,
        })
    }
}

struct Visitor {
    rule: &'static IconButtonRequiresTooltip,
    enabled: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if !is_icon_only_interactive(node, &self.rule.icon_components) {
            return;
        }
        if element_provides_tooltip(node) || has_tooltip_ancestor(node) {
            return;
        }
        let tag = element_tag_name(node).unwrap_or("control");
        ctx.report_node(
            node,
            RuleMessage::new(
                "missingTooltip",
                format!(
                    "Icon-only {tag} needs a tooltip. Wrap it in <Tooltip> with content, or use a component-level tooltip prop."
                ),
            ),
        );
    }
}

fn has_tooltip_ancestor(node: P<Node>) -> bool {
    let mut cursor = node.parent();
    while let Some(ancestor) = cursor {
        if is_jsx_element_like(ancestor) && element_provides_tooltip(ancestor) {
            return true;
        }
        cursor = ancestor.parent();
    }
    false
}

fn has_letter_or_number(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

fn is_icon_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["icon", "mark"].iter().any(|suffix| {
        lower.strip_suffix(suffix).is_some_and(|prefix| {
            prefix.is_empty()
                || prefix
                    .bytes()
                    .last()
                    .is_some_and(|byte| byte.is_ascii_alphabetic())
        })
    })
}

fn class_tokens(element: P<Node>) -> impl Iterator<Item = &'static str> {
    find_attribute(element, "className")
        .and_then(static_attribute_string)
        .unwrap_or("")
        .split_whitespace()
}

fn is_screen_reader_only(element: P<Node>) -> bool {
    class_tokens(element).any(|token| token == "sr-only")
}

fn element_has_visible_text(element: P<Node>) -> bool {
    !is_screen_reader_only(element)
        && jsx_children(element)
            .iter()
            .copied()
            .any(child_has_visible_text)
}

fn child_has_visible_text(child: P<Node>) -> bool {
    match child.kind() {
        Kind::JsxText => has_letter_or_number(child.as_jsx_text().text()),
        Kind::JsxElement | Kind::JsxSelfClosingElement => element_has_visible_text(child),
        Kind::JsxExpression => child
            .as_jsx_expression()
            .expression()
            .is_some_and(expression_has_visible_text),
        _ => false,
    }
}

fn expression_has_visible_text(expression: P<Node>) -> bool {
    let inner = unwrap_expression(expression);
    match inner.kind() {
        Kind::StringLiteral => cooked_text(inner).is_none_or(has_letter_or_number),
        Kind::CallExpression | Kind::NoSubstitutionTemplateLiteral | Kind::TemplateExpression => {
            true
        }
        Kind::BinaryExpression => {
            let bin = inner.as_binary_expression();
            match bin.operator_token().kind() {
                Kind::AmpersandAmpersandToken | Kind::BarBarToken | Kind::QuestionQuestionToken => {
                    expression_has_visible_text(bin.right())
                }
                _ => true,
            }
        }
        Kind::Identifier => !is_icon_name(inner.as_identifier().text()),
        Kind::PropertyAccessExpression => {
            let prop = inner.as_property_access_expression().name();
            if prop.kind() == Kind::PrivateIdentifier {
                return true;
            }
            ast::is_identifier(prop) && !is_icon_name(prop.as_identifier().text())
        }
        Kind::ElementAccessExpression => {
            let arg = inner.as_element_access_expression().argument_expression();
            !(ast::is_identifier(arg) && is_icon_name(arg.as_identifier().text()))
        }
        Kind::ConditionalExpression => {
            let cond = inner.as_conditional_expression();
            expression_has_visible_text(cond.when_true())
                || expression_has_visible_text(cond.when_false())
        }
        Kind::JsxElement | Kind::JsxSelfClosingElement => element_has_visible_text(inner),
        _ => false,
    }
}

fn is_icon_element(element: P<Node>, icons: &[String]) -> bool {
    element_tag_name(element).is_some_and(|name| {
        name == "svg"
            || name == "DirectionalIcon"
            || name.ends_with("Icon")
            || icons.iter().any(|icon| icon == name)
    })
}

fn has_icon_child(element: P<Node>, icons: &[String]) -> bool {
    jsx_children(element)
        .iter()
        .copied()
        .any(|child| match child.kind() {
            Kind::JsxElement | Kind::JsxSelfClosingElement => is_icon_element(child, icons),
            Kind::JsxExpression => child
                .as_jsx_expression()
                .expression()
                .map(unwrap_parentheses)
                .is_some_and(|expr| is_jsx_element_like(expr) && is_icon_element(expr, icons)),
            _ => false,
        })
}

fn is_icon_size_button(element: P<Node>) -> bool {
    if !matches!(element_tag_name(element), Some("Button" | "button")) {
        return false;
    }
    let icon_size = find_attribute(element, "size")
        .and_then(static_attribute_string)
        .is_some_and(|size| size.starts_with("icon"));
    icon_size
        || class_tokens(element).any(|token| {
            token
                .strip_prefix("size-")
                .is_some_and(|rest| rest.starts_with(|ch: char| ch.is_ascii_digit()))
        })
}

fn has_any_attribute(element: P<Node>, names: &[&str]) -> bool {
    jsx_attributes_list(element)
        .iter()
        .copied()
        .any(|attr| attribute_name(attr).is_some_and(|name| names.contains(&name)))
}

fn opening_provides_tooltip(element: P<Node>) -> bool {
    let name = element_tag_name(element);
    has_any_attribute(element, &TOOLTIP_ATTRIBUTES)
        || (name.is_some_and(|name| AUTO_TOOLTIP_ELEMENTS.contains(&name))
            && has_any_attribute(element, &AUTO_TOOLTIP_ATTRIBUTES))
        || (name == Some("button") && has_any_attribute(element, &NATIVE_TOOLTIP_ATTRIBUTES))
}

fn element_provides_tooltip(element: P<Node>) -> bool {
    element_tag_name(element).is_some_and(|name| TOOLTIP_ELEMENTS.contains(&name))
        || opening_provides_tooltip(element)
        || render_prop_element(element).is_some_and(opening_provides_tooltip)
}

fn is_icon_only_interactive(element: P<Node>, icons: &[String]) -> bool {
    let is_interactive =
        element_tag_name(element).is_some_and(|name| INTERACTIVE_ELEMENTS.contains(&name));
    if !is_interactive || element_has_visible_text(element) {
        return false;
    }
    render_prop_element(element).is_some_and(is_icon_size_button) || has_icon_child(element, icons)
}
