use antidrift_kernel::jsx::{
    attribute_initializer_expression, element_tag_name, find_attribute, is_jsx_element_like,
    jsx_attributes_list, jsx_children, plain_attribute_name, plain_element_name,
    render_prop_element,
};
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use antidrift_kernel::string_fragments::class_fragments;
use antidrift_kernel::tsrs_kernel::{cooked_text, unwrap_parentheses};
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const JSX_ELEMENT_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];
const JSX_OPENING_LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxOpeningElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];
const CALL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

const CENTERED_SCROLL_MESSAGE: &str = "Centered, width-capped column owns the vertical scroll (mx-auto + max-w-* + overflow-y-auto/scroll), so the scrollbar floats at the column edge instead of the pane edge next to the inspector rail. Move overflow to a full-width parent (e.g. flex-1 overflow-y-auto) and keep mx-auto/max-w-* on an inner content wrapper. (absolute/fixed/max-h-* boxes are exempt.)";

const TRIGGER_NAMES: [&str; 4] = [
    "AlertDialogTrigger",
    "DialogTrigger",
    "SheetTrigger",
    "PopoverTrigger",
];
const MENU_ITEM_NAMES: [&str; 4] = [
    "MenuItem",
    "MenuSubTrigger",
    "ContextMenuItem",
    "DropdownMenuItem",
];
const DIALOG_TRIGGER_MESSAGE: &str = "Do not mount a dialog trigger inside a menu item; the menu cannot close under the dialog. Lift the dialog beside the menu with `open` state and let the item request it.";

const TOOLTIP_ELEMENTS: [&str; 3] = ["Tooltip", "TooltipRoot", "TooltipTrigger"];
const MAX_RENDER_DEPTH: usize = 8;
const DISABLED_TOOLTIP_MESSAGE: &str = "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.";

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

const MISSING_LABEL: &str = "`detached(promise, context)` needs a context label. Pass a `\"feature.action\"` string literal naming the module and the work being detached.";
const NON_LITERAL_LABEL: &str = "The `detached` context label must be a plain `\"feature.action\"` string literal, so the telemetry tag stays stable and cannot carry an interpolated identifier. If a helper detaches for several call sites, return the promise and let each site pass its own literal.";
const BAD_LABEL_SHAPE: &str = "The `detached` context label must be two lowercase kebab-case segments, `\"feature.action\"` (for example `\"template-list.invalidate-templates\"`). Name the module or route slice, then the work being detached; an enclosing component or handler name is neither stable nor distinguishing.";

pub static NO_CENTERED_SCROLL_COLUMN: RuleSpec = RuleSpec::new(
    "antidrift/no-centered-scroll-column",
    &[],
    visit_centered_scroll_column,
);
pub static NO_DIALOG_TRIGGER_MENU_ITEM: RuleSpec = RuleSpec::new(
    "antidrift/no-dialog-trigger-menu-item",
    JSX_ELEMENT_LISTENERS,
    visit_dialog_trigger_menu_item,
);
pub static NO_DISABLED_TOOLTIP_TRIGGER: RuleSpec = RuleSpec::new(
    "antidrift/no-disabled-tooltip-trigger",
    JSX_ELEMENT_LISTENERS,
    visit_disabled_tooltip_trigger,
);
pub static NO_PORTAL_UNDER_INTERACTIVE_ANCESTOR: RuleSpec = RuleSpec::new(
    "antidrift/no-portal-under-interactive-ancestor",
    JSX_OPENING_LISTENERS,
    visit_portal_under_interactive_ancestor,
);
pub static REQUIRE_DETACHED_LABEL_SHAPE: RuleSpec = RuleSpec::new(
    "antidrift/require-detached-label-shape",
    CALL_LISTENERS,
    visit_detached_label_shape,
);

fn visit_centered_scroll_column(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
    for fragment in class_fragments(ctx.file) {
        if is_centered_scroll_column(fragment.text) {
            ctx.report_node(
                fragment.node,
                RuleMessage::new("centeredScrollColumn", CENTERED_SCROLL_MESSAGE),
            );
        }
    }
}

fn base_class(token: &str) -> &str {
    token.rsplit_once(':').map_or(token, |(_, base)| base)
}

fn is_centered_scroll_column(value: &str) -> bool {
    let classes: Vec<&str> = value
        .split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '{' | '}' | '(' | ')')
        })
        .filter(|token| !token.is_empty())
        .map(base_class)
        .collect();
    let has_scroll = classes.iter().any(|class| {
        matches!(
            *class,
            "overflow-auto" | "overflow-scroll" | "overflow-y-auto" | "overflow-y-scroll"
        )
    });
    let has_center = classes.contains(&"mx-auto");
    let has_max_width = classes.iter().any(|class| {
        class.starts_with("max-w-") && *class != "max-w-none" && *class != "max-w-full"
    });
    let exempt = classes
        .iter()
        .any(|class| *class == "absolute" || *class == "fixed" || class.starts_with("max-h-"));
    has_scroll && has_center && has_max_width && !exempt
}

fn visit_dialog_trigger_menu_item(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if element_tag_name(node).is_some_and(|name| TRIGGER_NAMES.contains(&name))
        && mounts_menu_item(node)
    {
        ctx.report_node(
            node,
            RuleMessage::new("triggerInsideMenuItem", DIALOG_TRIGGER_MESSAGE),
        );
    }
}

fn is_menu_item(element: P<Node>) -> bool {
    element_tag_name(element).is_some_and(|name| MENU_ITEM_NAMES.contains(&name))
}

fn mounts_menu_item(trigger: P<Node>) -> bool {
    render_prop_element(trigger).is_some_and(is_menu_item)
        || jsx_children(trigger)
            .iter()
            .copied()
            .any(|child| is_jsx_element_like(child) && is_menu_item(child))
}

fn visit_disabled_tooltip_trigger(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    if !ctx.file.file_name().ends_with(".tsx") {
        return;
    }
    if element_tag_name(node).is_some_and(|name| TOOLTIP_ELEMENTS.contains(&name))
        && triggers_disabled_button(node)
    {
        ctx.report_node(
            node,
            RuleMessage::new("unreachableTooltip", DISABLED_TOOLTIP_MESSAGE),
        );
    }
}

fn triggers_disabled_button(tooltip: P<Node>) -> bool {
    std::iter::successors(render_prop_element(tooltip), |&element| {
        render_prop_element(element)
    })
    .take(MAX_RENDER_DEPTH)
    .any(|element| {
        element_tag_name(element) == Some("Button") && find_attribute(element, "disabled").is_some()
    })
}

fn visit_portal_under_interactive_ancestor(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let Some(popup) = plain_element_name(node).filter(|name| PORTAL_POPUPS.contains(name)) else {
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

fn visit_detached_label_shape(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let call = node.as_call_expression();
    let callee = call.expression();
    if !ast::is_identifier(callee) || callee.as_identifier().text() != "detached" {
        return;
    }
    match call.arguments().nodes().get(1) {
        None => ctx.report_node(node, RuleMessage::new("missingLabel", MISSING_LABEL)),
        Some(&label) if label.kind() == Kind::StringLiteral => {
            if cooked_text(label).is_some_and(|text| !is_label_shape(text)) {
                ctx.report_node(label, RuleMessage::new("badLabelShape", BAD_LABEL_SHAPE));
            }
        }
        Some(&label) => {
            ctx.report_node(
                label,
                RuleMessage::new("nonLiteralLabel", NON_LITERAL_LABEL),
            );
        }
    }
}

fn is_kebab_word(segment: &str) -> bool {
    !segment.is_empty()
        && segment.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn is_label_shape(label: &str) -> bool {
    label
        .split_once('.')
        .is_some_and(|(feature, action)| is_kebab_word(feature) && is_kebab_word(action))
}
