use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleSpec, RuleVisitor};
use antidrift_kernel::tsrs_kernel::cooked_text;
use serde::Deserialize;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;

const CALL_LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];
const IMPORT_LISTENERS: &[Listener] = &[Listener::Enter(Kind::ImportDeclaration)];

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
const DEVTOOLS_PACKAGES: &[&str] = &[
    "@tanstack/react-devtools",
    "@tanstack/react-query-devtools",
    "@tanstack/react-router-devtools",
    "@tanstack/react-table-devtools",
];

pub static NO_PLACEHOLDER_TESTS: RuleSpec = RuleSpec::new(
    "antidrift/no-placeholder-tests",
    CALL_LISTENERS,
    visit_placeholder_tests,
);

pub static NO_REDACTED_LOG_ATTRIBUTE_KEY: RuleSpec = RuleSpec::new(
    "antidrift/no-redacted-log-attribute-key",
    CALL_LISTENERS,
    visit_redacted_log_attribute_key,
);

fn visit_placeholder_tests(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
    let call = node.as_call_expression();
    let callee = call.expression();
    let args = call.arguments().nodes();
    if ast::is_identifier(callee)
        && matches!(callee.as_identifier().text(), "it" | "test")
        && args.len() >= 2
        && let Some(body) = extract_test_block_body(args[1])
        && is_empty_or_placeholder_body(body)
    {
        ctx.report_node(
            node,
            RuleMessage::new(
                "placeholder",
                "Test body is empty or placeholder-only. Write a real test or remove it.",
            ),
        );
    }
}

fn extract_test_block_body(arg: P<Node>) -> Option<P<Node>> {
    match arg.kind() {
        Kind::ArrowFunction | Kind::FunctionExpression => {
            arg.body().filter(|body| body.kind() == Kind::Block)
        }
        _ => None,
    }
}

fn is_empty_or_placeholder_body(body: P<Node>) -> bool {
    let stmts = body.as_block().statements().nodes();
    if stmts.is_empty() {
        return true;
    }
    for &stmt in stmts {
        if stmt.kind() == Kind::ExpressionStatement {
            let expr = stmt.as_expression_statement().expression();
            if expr.kind() == Kind::StringLiteral {
                return cooked_text(expr).is_some_and(has_placeholder_word);
            }
        }
    }
    false
}

fn has_placeholder_word(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    for token in ["todo", "fixme", "placeholder"] {
        if contains_word(&lower, token) {
            return true;
        }
    }
    contains_word_pair(&lower, "implement", "later") || contains_word_pair(&lower, "mock", "data")
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    for (idx, _) in haystack.match_indices(needle) {
        let before_ok = idx == 0 || !is_word_byte(bytes[idx - 1]);
        let end = idx + needle.len();
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn contains_word_pair(haystack: &str, first: &str, second: &str) -> bool {
    let bytes = haystack.as_bytes();
    for (idx, _) in haystack.match_indices(first) {
        if idx > 0 && is_word_byte(bytes[idx - 1]) {
            continue;
        }
        let after_first = idx + first.len();
        for sep_len in [0, 1] {
            let second_start = after_first + sep_len;
            let second_end = second_start + second.len();
            if second_end <= bytes.len()
                && &haystack[second_start..second_end] == second
                && (second_end == bytes.len() || !is_word_byte(bytes[second_end]))
            {
                return true;
            }
        }
    }
    false
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn visit_redacted_log_attribute_key(ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
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
        Kind::StringLiteral => cooked_text(key),
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

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct NoStaticDevtoolsImportOptions {
    modules: Vec<String>,
}

pub struct NoStaticDevtoolsImport {
    modules: Vec<String>,
}

pub static NO_STATIC_DEVTOOLS_IMPORT: NoStaticDevtoolsImport = NoStaticDevtoolsImport {
    modules: Vec::new(),
};

impl crate::ConfigurableRule for NoStaticDevtoolsImport {
    type Options = NoStaticDevtoolsImportOptions;

    fn from_options(parsed: Self::Options) -> Result<Self, String> {
        Ok(Self {
            modules: parsed.modules,
        })
    }
}

impl Rule for NoStaticDevtoolsImport {
    fn name(&self) -> &'static str {
        "antidrift/no-static-devtools-import"
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(DevtoolsVisitor { rule: self })
    }
}

struct DevtoolsVisitor {
    rule: &'static NoStaticDevtoolsImport,
}

impl RuleVisitor for DevtoolsVisitor {
    fn listeners(&self) -> &[Listener] {
        IMPORT_LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, node: P<Node>) {
        if is_type_only_import(node) {
            return;
        }
        let spec = node.as_import_declaration().module_specifier();
        if !ast::is_string_literal(spec) {
            return;
        }
        let Some(source) = cooked_text(spec) else {
            return;
        };
        if DEVTOOLS_PACKAGES.contains(&source) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "staticDevtoolsPackage",
                    "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.",
                ),
            );
            return;
        }
        if self.rule.modules.iter().any(|module| module == source) {
            ctx.report_node(
                node,
                RuleMessage::new(
                    "staticDevtoolsModule",
                    "Keep devtools modules behind a dynamic import so route shells can mount before devtools code loads.",
                ),
            );
        }
    }
}

fn is_type_only_import(import_node: P<Node>) -> bool {
    let Some(clause_node) = import_node.as_import_declaration().import_clause() else {
        return false;
    };
    let clause = clause_node.as_import_clause();
    if clause.phase_modifier() == Kind::TypeKeyword {
        return true;
    }
    if clause.name().is_some() {
        return false;
    }
    let Some(bindings) = clause.named_bindings() else {
        return false;
    };
    if bindings.kind() != Kind::NamedImports {
        return false;
    }
    let elems = bindings.as_named_imports().elements().nodes();
    !elems.is_empty()
        && elems.iter().all(|&spec| {
            spec.kind() == Kind::ImportSpecifier && spec.as_import_specifier().is_type_only()
        })
}
