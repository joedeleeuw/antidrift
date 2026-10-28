use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-placeholder-tests";

pub struct NoPlaceholderTests {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoPlaceholderTests = NoPlaceholderTests {
    scope: RuleScope::DEFAULT,
};

impl NoPlaceholderTests {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::CallExpression)];

impl Rule for NoPlaceholderTests {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let filename = ctx.file.file_name().replace('\\', "/");
        let enabled = self.scope.matches(&filename, cwd) && is_test_filename(&filename);
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
                return has_placeholder_word(expr.as_string_literal().text());
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

pub(super) fn is_test_filename(filename: &str) -> bool {
    for ext in [
        ".test.ts",
        ".test.tsx",
        ".test.js",
        ".test.jsx",
        ".test.mts",
        ".test.cts",
        ".test.mjs",
        ".test.cjs",
        ".spec.ts",
        ".spec.tsx",
        ".spec.js",
        ".spec.jsx",
        ".spec.mts",
        ".spec.cts",
        ".spec.mjs",
        ".spec.cjs",
    ] {
        if filename.ends_with(ext) {
            return true;
        }
    }
    filename
        .split('/')
        .any(|seg| matches!(seg, "test" | "tests" | "__tests__"))
}
