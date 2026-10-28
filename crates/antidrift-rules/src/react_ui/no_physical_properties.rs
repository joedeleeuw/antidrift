use antidrift_kernel::jsx::class_fragments;
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use tsrs_ast::Node;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-physical-properties";
const MESSAGE: &str = "Physical directional CSS property breaks RTL. Use logical equivalents: ml→ms, mr→me, pl→ps, pr→pe, left→start, right→end, text-left→text-start, text-right→text-end, border-l→border-s, border-r→border-e, rounded-l→rounded-s, rounded-r→rounded-e.";

pub struct NoPhysicalProperties {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoPhysicalProperties = NoPhysicalProperties {
    scope: RuleScope::DEFAULT,
};

impl NoPhysicalProperties {
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

impl Rule for NoPhysicalProperties {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        if !in_scope(&self.scope, ctx, None) {
            return Box::new(NoopVisitor);
        }
        for fragment in class_fragments(ctx.file) {
            if has_physical_property(&without_symmetric_insets(fragment.text)) {
                ctx.report_node(fragment.node, RuleMessage::new("physicalProperty", MESSAGE));
            }
        }
        Box::new(NoopVisitor)
    }
}

#[derive(Clone, Copy)]
enum Terminator {
    Open,
    Closed,
    ClosedOrDash,
}

struct PhysicalPattern {
    word: &'static str,
    allows_negative: bool,
    terminator: Terminator,
}

const fn pattern(
    word: &'static str,
    allows_negative: bool,
    terminator: Terminator,
) -> PhysicalPattern {
    PhysicalPattern {
        word,
        allows_negative,
        terminator,
    }
}

const PHYSICAL_PATTERNS: [PhysicalPattern; 20] = [
    pattern("ml-", true, Terminator::Open),
    pattern("mr-", true, Terminator::Open),
    pattern("pl-", true, Terminator::Open),
    pattern("pr-", true, Terminator::Open),
    pattern("text-left", false, Terminator::Closed),
    pattern("text-right", false, Terminator::Closed),
    pattern("border-l", false, Terminator::ClosedOrDash),
    pattern("border-r", false, Terminator::ClosedOrDash),
    pattern("rounded-tl", false, Terminator::ClosedOrDash),
    pattern("rounded-tr", false, Terminator::ClosedOrDash),
    pattern("rounded-bl", false, Terminator::ClosedOrDash),
    pattern("rounded-br", false, Terminator::ClosedOrDash),
    pattern("rounded-l", false, Terminator::ClosedOrDash),
    pattern("rounded-r", false, Terminator::ClosedOrDash),
    pattern("left-", true, Terminator::Open),
    pattern("right-", true, Terminator::Open),
    pattern("scroll-ml-", false, Terminator::Open),
    pattern("scroll-mr-", false, Terminator::Open),
    pattern("scroll-pl-", false, Terminator::Open),
    pattern("scroll-pr-", false, Terminator::Open),
];

fn is_token_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '{' | '(')
}

fn is_closing(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '}' | ')')
}

fn is_variant_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'[' | b']' | b':')
}

fn terminates(terminator: Terminator, rest: &str) -> bool {
    let Some(next) = rest.chars().next() else {
        return true;
    };
    match terminator {
        Terminator::Open => true,
        Terminator::Closed => is_closing(next),
        Terminator::ClosedOrDash => next == '-' || is_closing(next),
    }
}

fn match_word_after_variant(
    value: &str,
    start: usize,
    rule: &PhysicalPattern,
) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    let run_end = start
        + bytes[start..]
            .iter()
            .take_while(|byte| is_variant_char(**byte))
            .count();
    (start..=run_end)
        .rev()
        .filter(|&candidate| candidate == start || bytes[candidate - 1] == b':')
        .find_map(|candidate| {
            let end = candidate + rule.word.len();
            (value[candidate..].starts_with(rule.word)
                && terminates(rule.terminator, &value[end..]))
            .then_some((candidate, end))
        })
}

fn match_at(value: &str, position: usize, rule: &PhysicalPattern) -> Option<(usize, usize)> {
    let mut starts = Vec::with_capacity(2);
    if position == 0 {
        starts.push(0);
    }
    if let Some(ch) = value[position..]
        .chars()
        .next()
        .filter(|ch| is_token_boundary(*ch))
    {
        starts.push(position + ch.len_utf8());
    }
    starts.into_iter().find_map(|after_boundary| {
        let negative = rule.allows_negative && value[after_boundary..].starts_with('-');
        let with_sign = negative
            .then(|| match_word_after_variant(value, after_boundary + 1, rule))
            .flatten();
        with_sign.or_else(|| match_word_after_variant(value, after_boundary, rule))
    })
}

fn contains_match(value: &str, rule: &PhysicalPattern) -> bool {
    value
        .char_indices()
        .any(|(position, _)| match_at(value, position, rule).is_some())
}

fn has_physical_property(value: &str) -> bool {
    PHYSICAL_PATTERNS
        .iter()
        .any(|rule| contains_match(value, rule))
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn inset_at(value: &str, position: usize) -> Option<(&'static str, usize, usize)> {
    let bytes = value.as_bytes();
    if position > 0 && is_word_byte(bytes[position - 1]) {
        return None;
    }
    let (side, other) = if value[position..].starts_with("left-") {
        ("left-", "right")
    } else if value[position..].starts_with("right-") {
        ("right-", "left")
    } else {
        return None;
    };
    let size_start = position + side.len();
    let run = bytes[size_start..]
        .iter()
        .take_while(|byte| is_word_byte(**byte) || **byte == b'.')
        .count();
    let trimmed = value[size_start..size_start + run]
        .trim_end_matches('.')
        .len();
    (trimmed > 0).then_some((other, size_start, size_start + trimmed))
}

fn without_symmetric_insets(value: &str) -> String {
    let tokens: Vec<&str> = value.split_whitespace().collect();
    let mut kept = String::with_capacity(value.len());
    let mut copied = 0;
    let mut position = 0;
    while position < value.len() {
        if let Some((other, size_start, end)) = inset_at(value, position) {
            let mirrored = format!("{other}-{}", &value[size_start..end]);
            kept.push_str(&value[copied..position]);
            if !tokens.contains(&mirrored.as_str()) {
                kept.push_str(&value[position..end]);
            }
            copied = end;
            position = end;
            continue;
        }
        position += value[position..].chars().next().map_or(1, char::len_utf8);
    }
    kept.push_str(&value[copied..]);
    kept
}
