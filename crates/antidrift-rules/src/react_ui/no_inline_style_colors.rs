use antidrift_kernel::jsx::{attribute_initializer_expression, plain_attribute_name};
use antidrift_kernel::rule_scope::{RuleScope, in_scope};
use antidrift_kernel::tsrs_kernel::{unwrap_expression, unwrap_parentheses};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-inline-style-colors";
const SAFE_KEYWORDS: [&str; 7] = [
    "transparent",
    "inherit",
    "currentcolor",
    "unset",
    "initial",
    "none",
    "auto",
];
const NAMED_COLORS: [&str; 7] = ["white", "black", "red", "blue", "green", "gray", "grey"];

pub struct NoInlineStyleColors {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoInlineStyleColors = NoInlineStyleColors {
    scope: RuleScope::DEFAULT,
};

impl NoInlineStyleColors {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::JsxAttribute)];

impl Rule for NoInlineStyleColors {
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
        if plain_attribute_name(node) != Some("style") {
            return;
        }
        let Some(expr) = attribute_initializer_expression(node) else {
            return;
        };
        let style = unwrap_expression(expr);
        if style.kind() != Kind::ObjectLiteralExpression {
            return;
        }
        for &property in style.as_object_literal_expression().properties().nodes() {
            if property.kind() != Kind::PropertyAssignment {
                continue;
            }
            let assign = property.as_property_assignment();
            let val_node = assign.initializer();
            let Some(text) = static_style_value(val_node) else {
                continue;
            };
            let Some(color) = hardcoded_color(text) else {
                continue;
            };
            let prop = property_label(assign.name());
            ctx.report_node(
                val_node,
                RuleMessage::new(
                    "inlineColor",
                    format!(
                        "Hardcoded color '{color}' in '{prop}' breaks dark mode. Use a CSS variable or Tailwind class instead."
                    ),
                ),
            );
        }
    }
}

fn static_style_value(value: P<Node>) -> Option<&'static str> {
    let inner = unwrap_parentheses(value);
    match inner.kind() {
        Kind::StringLiteral => Some(inner.as_string_literal().text()),
        Kind::NoSubstitutionTemplateLiteral => Some(inner.text()),
        _ => None,
    }
}

fn property_label(key: P<Node>) -> &'static str {
    match key.kind() {
        Kind::Identifier => key.as_identifier().text(),
        Kind::StringLiteral => key.as_string_literal().text(),
        _ => "?",
    }
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn word_start(bytes: &[u8], position: usize) -> bool {
    position == 0 || !is_word(bytes[position - 1])
}

fn word_end(bytes: &[u8], position: usize) -> bool {
    bytes.get(position).is_none_or(|byte| !is_word(*byte))
}

fn strip_var_expressions(value: &str) -> String {
    let mut stripped = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("var(") {
        stripped.push_str(&rest[..start]);
        let mut depth = 1_usize;
        let mut end = start + 4;
        for (offset, ch) in rest[start + 4..].char_indices() {
            end = start + 4 + offset + ch.len_utf8();
            match ch {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                break;
            }
        }
        if depth > 0 {
            end = rest.len();
        }
        rest = &rest[end..];
    }
    stripped.push_str(rest);
    stripped
}

fn hex_color(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    value.match_indices('#').find_map(|(position, _)| {
        let digits = bytes[position + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .count();
        ((3..=8).contains(&digits) && word_end(bytes, position + 1 + digits))
            .then(|| &value[position..=position + digits])
    })
}

fn color_function(value: &str) -> Option<&str> {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    (0..bytes.len())
        .filter(|&position| word_start(bytes, position))
        .find_map(|position| {
            ["rgba", "rgb", "hsla", "hsl"].iter().find_map(|name| {
                let after_name = position + name.len();
                if !lower[position..].starts_with(name) {
                    return None;
                }
                let spaces = lower[after_name..].len() - lower[after_name..].trim_start().len();
                lower[after_name + spaces..]
                    .starts_with('(')
                    .then(|| &value[position..=after_name + spaces])
            })
        })
}

fn remove_white_space_property(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut kept = String::with_capacity(value.len());
    let mut copied = 0;
    let mut position = 0;
    while let Some(offset) = lower[position..].find("white-space") {
        let start = position + offset;
        let end = start + "white-space".len();
        if word_start(bytes, start) && word_end(bytes, end) {
            kept.push_str(&value[copied..start]);
            copied = end;
        }
        position = start + 1;
    }
    kept.push_str(&value[copied..]);
    kept
}

fn named_color(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    (0..bytes.len())
        .filter(|&position| word_start(bytes, position))
        .find_map(|position| {
            NAMED_COLORS
                .iter()
                .find(|name| {
                    lower[position..].starts_with(*name) && word_end(bytes, position + name.len())
                })
                .map(|name| value[position..position + name.len()].to_string())
        })
}

fn hardcoded_color(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    if value.starts_with("var(") || SAFE_KEYWORDS.contains(&lower.trim()) {
        return None;
    }
    let stripped = strip_var_expressions(value);
    if let Some(hex) = hex_color(&stripped) {
        return Some(hex.to_owned());
    }
    if let Some(function) = color_function(&stripped) {
        return Some(function.to_owned());
    }
    named_color(&remove_white_space_property(&stripped))
}
