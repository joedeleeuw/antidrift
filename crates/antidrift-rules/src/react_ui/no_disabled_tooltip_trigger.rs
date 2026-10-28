use antidrift_kernel::jsx::{element_tag_name, find_attribute, render_prop_element};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-disabled-tooltip-trigger";
const TOOLTIP_ELEMENTS: [&str; 3] = ["Tooltip", "TooltipRoot", "TooltipTrigger"];
const MAX_RENDER_DEPTH: usize = 8;
const MESSAGE: &str = "A disabled Button receives no hover or focus, so this tooltip can never open. Pass the content to the Button's own `tooltip` prop, which keeps the button reachable while blocking activation.";

pub struct NoDisabledTooltipTrigger {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoDisabledTooltipTrigger = NoDisabledTooltipTrigger {
    scope: RuleScope::DEFAULT,
};

impl NoDisabledTooltipTrigger {
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

impl Rule for NoDisabledTooltipTrigger {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = ctx.file.file_name().ends_with(".tsx") && in_scope(&self.scope, ctx, None);
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
        if element_tag_name(node).is_some_and(|name| TOOLTIP_ELEMENTS.contains(&name))
            && triggers_disabled_button(node)
        {
            ctx.report_node(node, RuleMessage::new("unreachableTooltip", MESSAGE));
        }
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
