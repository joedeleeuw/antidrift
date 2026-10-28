use antidrift_kernel::jsx::string_fragments;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::Node;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-raw-foreground-opacity";
const UTILITY_PREFIXES: [&str; 5] = ["text", "decoration", "bg", "border", "ring"];
const FOREGROUND_TOKENS: [&str; 2] = ["muted-foreground", "foreground"];
const RAW_OPACITIES: [&str; 8] = ["40", "45", "50", "60", "64", "70", "72", "80"];

pub struct NoRawForegroundOpacity {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoRawForegroundOpacity = NoRawForegroundOpacity {
    scope: RuleScope::DEFAULT,
};

impl NoRawForegroundOpacity {
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

impl Rule for NoRawForegroundOpacity {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(NoopVisitor);
        }
        for fragment in string_fragments(ctx.file) {
            let Some(token) = fragment
                .text
                .split_whitespace()
                .find(|token| is_raw_foreground_opacity(token))
            else {
                continue;
            };
            ctx.report_node(
                fragment.node,
                RuleMessage::new(
                    "rawForegroundOpacity",
                    format!(
                        "Raw foreground opacity '{token}' hides visual intent. Use a named token such as text-foreground-muted, text-foreground-placeholder, border-foreground-disabled, or text-foreground-strong-muted."
                    ),
                ),
            );
        }
        Box::new(NoopVisitor)
    }
}

fn opacity_suffix_matches(rest: &str) -> bool {
    RAW_OPACITIES.iter().any(|opacity| {
        rest.strip_prefix(opacity).is_some_and(|after| {
            after
                .chars()
                .next()
                .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'))
        })
    })
}

fn matches_raw_opacity_at(token: &str) -> bool {
    UTILITY_PREFIXES.iter().any(|prefix| {
        token
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|rest| {
                FOREGROUND_TOKENS.iter().any(|color| {
                    rest.strip_prefix(color)
                        .and_then(|after| after.strip_prefix('/'))
                        .is_some_and(opacity_suffix_matches)
                })
            })
    })
}

fn is_raw_foreground_opacity(token: &str) -> bool {
    matches_raw_opacity_at(token)
        || token
            .match_indices(':')
            .any(|(index, _)| matches_raw_opacity_at(&token[index + 1..]))
}
