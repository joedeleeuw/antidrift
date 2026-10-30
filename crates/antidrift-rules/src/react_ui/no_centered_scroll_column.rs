use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::string_fragments::class_fragments;
use tsrs_ast::Node;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-centered-scroll-column";
const MESSAGE: &str = "Centered, width-capped column owns the vertical scroll (mx-auto + max-w-* + overflow-y-auto/scroll), so the scrollbar floats at the column edge instead of the pane edge next to the inspector rail. Move overflow to a full-width parent (e.g. flex-1 overflow-y-auto) and keep mx-auto/max-w-* on an inner content wrapper. (absolute/fixed/max-h-* boxes are exempt.)";

pub struct NoCenteredScrollColumn {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoCenteredScrollColumn = NoCenteredScrollColumn {
    scope: RuleScope::DEFAULT,
};

impl NoCenteredScrollColumn {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

struct NoopVisitor;

impl RuleVisitor for NoopVisitor {
    fn listeners(&self) -> &[Listener] {
        &[]
    }

    fn visit(&mut self, _ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {}
}

impl Rule for NoCenteredScrollColumn {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(NoopVisitor);
        }
        for fragment in class_fragments(ctx.file) {
            if is_centered_scroll_column(fragment.text) {
                ctx.report_node(
                    fragment.node,
                    RuleMessage::new("centeredScrollColumn", MESSAGE),
                );
            }
        }
        Box::new(NoopVisitor)
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
