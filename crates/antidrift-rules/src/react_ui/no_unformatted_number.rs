use antidrift_kernel::file_role::is_test_or_spec_file;
use antidrift_kernel::jsx::{has_plain_attribute, plain_attribute_name, plain_element_name};
use antidrift_kernel::rule_scope::{
    RuleScope, ScopeOptions, ScopedOptions, decode_scoped, in_scope, require_non_empty,
};
use antidrift_kernel::tsrs_kernel::unwrap_parentheses;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_checker::TypeFlags;
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-unformatted-number";
const DEFAULT_FORMATTER: &str = "Intl.NumberFormat(locale).format(value)";
const NUMERIC_WORDS: [&str; 17] = [
    "count", "gpu", "total", "subtotal", "amount", "sum", "quantity", "qty", "hour", "hours",
    "minute", "minutes", "second", "seconds", "price", "balance", "score",
];
const NON_DISPLAY_ATTRIBUTES: [&str; 11] = [
    "key",
    "id",
    "htmlFor",
    "className",
    "style",
    "type",
    "role",
    "name",
    "slot",
    "form",
    "dir",
];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct UnformattedNumberOptions {
    #[serde(flatten)]
    scope: ScopeOptions,
    formatter: Option<String>,
}

impl ScopedOptions for UnformattedNumberOptions {
    fn scope(&self) -> ScopeOptions {
        self.scope.clone()
    }

    fn validate(&self, rule_name: &str) -> Result<(), String> {
        require_non_empty(rule_name, "formatter", self.formatter.as_ref())
    }
}

pub struct NoUnformattedNumber {
    scope: RuleScope,
    formatter: Option<String>,
}

pub static DEFAULT_RULE: NoUnformattedNumber = NoUnformattedNumber {
    scope: RuleScope::DEFAULT,
    formatter: None,
};

impl NoUnformattedNumber {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        let (parsed, scope) = decode_scoped::<UnformattedNumberOptions>(RULE_NAME, options)?;
        Ok(Self {
            scope,
            formatter: parsed.formatter,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::JsxExpression)];

impl Rule for NoUnformattedNumber {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let enabled = in_scope(&self.scope, ctx, None);
        let test_file = is_test_or_spec_file(ctx.file.file_name());
        Box::new(Visitor {
            rule: self,
            enabled,
            test_file,
        })
    }
}

struct Visitor {
    rule: &'static NoUnformattedNumber,
    enabled: bool,
    test_file: bool,
}

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        if self.enabled { LISTENERS } else { &[] }
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if (self.test_file && is_test_output_element(node)) || in_non_display_attribute(node) {
            return;
        }
        let Some(expression) = node.as_jsx_expression().expression() else {
            return;
        };
        let is_text_child = node
            .parent()
            .is_some_and(|parent| matches!(parent.kind(), Kind::JsxElement | Kind::JsxFragment));
        let unwrapped = unwrap_parentheses(expression);
        if is_string_call(ctx, unwrapped)
            || is_numeric_template(ctx, unwrapped)
            || (is_text_child && is_numeric_expression(ctx, unwrapped))
        {
            let formatter = self.rule.formatter.as_deref().unwrap_or(DEFAULT_FORMATTER);
            ctx.report_node(
                node,
                RuleMessage::new(
                    "unformatted",
                    format!(
                        "Format displayed numbers with {formatter} so the selected locale controls digits and grouping."
                    ),
                ),
            );
        }
    }
}

fn name_segments(name: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(name.len() + 4);
    let mut previous: Option<char> = None;
    for ch in name.chars() {
        if ch.is_ascii_uppercase()
            && previous.is_some_and(|prev| prev.is_ascii_lowercase() || prev.is_ascii_digit())
        {
            spaced.push(' ');
        }
        spaced.push(if ch == '_' { ' ' } else { ch });
        previous = Some(ch);
    }
    spaced
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn is_numeric_name(name: &str) -> bool {
    name_segments(name)
        .iter()
        .any(|segment| NUMERIC_WORDS.contains(&segment.as_str()))
}

fn is_checker_number(ctx: &mut Ctx, node: P<Node>) -> bool {
    let typ = ctx.checker.get_type_at_location(node);
    let flags = typ.flags();
    flags.intersects(TypeFlags::NumberLike)
        && !flags.intersects(TypeFlags::Any | TypeFlags::Unknown | TypeFlags::Never)
}

fn is_numeric_expression(ctx: &mut Ctx, expression: P<Node>) -> bool {
    let inner = unwrap_parentheses(expression);
    match inner.kind() {
        Kind::Identifier => {
            is_numeric_name(inner.as_identifier().text()) || is_checker_number(ctx, inner)
        }
        Kind::PropertyAccessExpression => {
            let prop = inner.as_property_access_expression().name();
            if !ast::is_identifier(prop) {
                return false;
            }
            let name = prop.as_identifier().text();
            name == "length" || is_numeric_name(name) || is_checker_number(ctx, inner)
        }
        Kind::ElementAccessExpression => {
            let arg = inner.as_element_access_expression().argument_expression();
            if !ast::is_identifier(arg) {
                return is_checker_number(ctx, inner);
            }
            let name = arg.as_identifier().text();
            name == "length" || is_numeric_name(name) || is_checker_number(ctx, inner)
        }
        _ => false,
    }
}

fn is_string_call(ctx: &mut Ctx, expression: P<Node>) -> bool {
    if expression.kind() != Kind::CallExpression {
        return false;
    }
    let call = expression.as_call_expression();
    let callee = call.expression();
    ast::is_identifier(callee)
        && callee.as_identifier().text() == "String"
        && call.arguments().nodes().first().is_some_and(|&arg| {
            arg.kind() != Kind::SpreadElement && is_numeric_expression(ctx, arg)
        })
}

fn is_numeric_template(ctx: &mut Ctx, expression: P<Node>) -> bool {
    expression.kind() == Kind::TemplateExpression
        && expression
            .as_template_expression()
            .template_spans()
            .nodes()
            .iter()
            .any(|&span| is_numeric_expression(ctx, span.as_template_span().expression()))
}

fn is_test_output_element(container: P<Node>) -> bool {
    let Some(parent) = container.parent() else {
        return false;
    };
    parent.kind() == Kind::JsxElement
        && plain_element_name(parent) == Some("output")
        && has_plain_attribute(parent, "data-testid")
}

fn in_non_display_attribute(container: P<Node>) -> bool {
    container
        .parent()
        .and_then(plain_attribute_name)
        .is_some_and(|name| NON_DISPLAY_ATTRIBUTES.contains(&name))
}
