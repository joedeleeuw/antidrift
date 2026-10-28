use antidrift_kernel::jsx::{
    element_tag_name, is_jsx_element_like, jsx_children, render_prop_element,
};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-dialog-trigger-menu-item";
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
const MESSAGE: &str = "Do not mount a dialog trigger inside a menu item; the menu cannot close under the dialog. Lift the dialog beside the menu with `open` state and let the item request it.";

pub struct NoDialogTriggerMenuItem {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoDialogTriggerMenuItem = NoDialogTriggerMenuItem {
    scope: RuleScope::DEFAULT,
};

impl NoDialogTriggerMenuItem {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[
    Listener::Enter(Kind::JsxElement),
    Listener::Enter(Kind::JsxSelfClosingElement),
];

impl Rule for NoDialogTriggerMenuItem {
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
        if element_tag_name(node).is_some_and(|name| TRIGGER_NAMES.contains(&name))
            && mounts_menu_item(node)
        {
            ctx.report_node(node, RuleMessage::new("triggerInsideMenuItem", MESSAGE));
        }
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
