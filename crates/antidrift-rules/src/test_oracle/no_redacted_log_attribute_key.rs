use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-redacted-log-attribute-key";

const LOGGER_METHODS: &[&str] = &["debug", "error", "info", "warn"];
const SENSITIVE_SUBSTRINGS: &[&str] = &[
    "body",
    "content",
    "email",
    "filename",
    "message",
    "name",
    "title",
    "password",
    "secret",
    "credential",
    "authorization",
    "cookie",
    "bearer",
    "snippet",
    "subject",
    "phone",
];

pub struct NoRedactedLogAttributeKey {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoRedactedLogAttributeKey = NoRedactedLogAttributeKey {
    scope: RuleScope::DEFAULT,
};

impl NoRedactedLogAttributeKey {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoRedactedLogAttributeKey {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let filename = ctx.file.file_name().replace('\\', "/");
        Box::new(Visitor {
            enabled: self.scope.matches(&filename, cwd),
        })
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
        if !is_logger_call(node) {
            return;
        }
        let Some(&attrs) = node.as_call_expression().arguments().nodes().get(1) else {
            return;
        };
        if attrs.kind() != Kind::ObjectLiteralExpression {
            return;
        }
        for &prop in attrs.as_object_literal_expression().properties().nodes() {
            let Some(key_name) = extract_property_name(prop) else {
                continue;
            };
            if is_sensitive_log_attribute_key(key_name) {
                ctx.report_node(
                    prop,
                    RuleMessage::new(
                        "redactedKey",
                        format!(
                            "Log attribute `{key_name}` matches the logger's sensitive-key denylist, so the sanitizer drops it and the record ships without it. Rename the key (for example `queue` instead of `queueName`), or leave the value out if it is a payload."
                        ),
                    ),
                );
            }
        }
    }
}

fn is_logger_call(call_node: P<Node>) -> bool {
    let callee = call_node.as_call_expression().expression();
    if callee.kind() != Kind::PropertyAccessExpression {
        return false;
    }
    let access = callee.as_property_access_expression();
    let obj = access.expression();
    let prop = access.name();
    ast::is_identifier(obj)
        && obj.as_identifier().text() == "logger"
        && ast::is_identifier(prop)
        && LOGGER_METHODS.contains(&prop.as_identifier().text())
}

fn extract_property_name(prop: P<Node>) -> Option<&'static str> {
    let key = match prop.kind() {
        Kind::PropertyAssignment => prop.as_property_assignment().name(),
        Kind::ShorthandPropertyAssignment => prop.as_shorthand_property_assignment().name(),
        _ => return None,
    };
    match key.kind() {
        Kind::Identifier => Some(key.as_identifier().text()),
        Kind::StringLiteral => Some(key.as_string_literal().text()),
        _ => None,
    }
}

fn is_sensitive_log_attribute_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if SENSITIVE_SUBSTRINGS.iter().any(|sub| lower.contains(sub)) {
        return true;
    }
    if lower.contains("apikey") || lower.contains("api_key") || lower.contains("api-key") {
        return true;
    }
    for (idx, _) in lower.match_indices("prompt") {
        let rest = &lower[idx + "prompt".len()..];
        if !rest.starts_with("token") && !rest.starts_with("_token") {
            return true;
        }
    }
    false
}
