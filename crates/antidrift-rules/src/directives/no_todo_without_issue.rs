use super::no_tutorial_comments::split_identifier_words;
use antidrift_kernel::directives::scan_source_comments;
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-todo-without-issue";

const DEBT_TOKENS: &[&str] = &["todo", "fixme", "hack", "temporary", "later", "cleanup"];
const AI_TOKENS: &[&str] = &[
    "ai",
    "llm",
    "gpt",
    "copilot",
    "claude",
    "gemini",
    "cursor",
    "generated",
];

pub struct NoTodoWithoutIssue {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoTodoWithoutIssue = NoTodoWithoutIssue {
    scope: RuleScope::DEFAULT,
};

impl NoTodoWithoutIssue {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoTodoWithoutIssue {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        let cwd = ctx.program.host().get_current_directory();
        let enabled = self.scope.matches(ctx.file.file_name(), cwd);
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

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        for comment in scan_source_comments(ctx.file.text()) {
            let text = comment.raw_content;
            if has_tracked_ticket(text) {
                continue;
            }
            let words = split_identifier_words(text);
            let has_debt = words.iter().any(|w| DEBT_TOKENS.contains(&w.as_str()));
            let has_ai = words.iter().any(|w| AI_TOKENS.contains(&w.as_str()));
            if has_debt && has_ai {
                ctx.report_range(
                    comment.pos,
                    comment.end,
                    RuleMessage::new(
                        "forbidden",
                        "AI debt comment is forbidden. Replace with immediate fix or a tracked issue reference outside source files.",
                    ),
                );
                continue;
            }
            if let Some(bare_token) = words
                .iter()
                .find(|w| matches!(w.as_str(), "todo" | "fixme" | "hack"))
            {
                let upper = bare_token.to_ascii_uppercase();
                ctx.report_range(
                    comment.pos,
                    comment.end,
                    RuleMessage::new(
                        "bareToken",
                        format!(
                            "{upper} comment must include a tracked issue reference (e.g. TODO(ABC-123))."
                        ),
                    ),
                );
            }
        }
    }
}

fn has_tracked_ticket(text: &str) -> bool {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut idx = 0;
    while idx < len {
        if let Some(after_kw) = match_todo_keyword(bytes, idx)
            && has_ticket_after_keyword(bytes, after_kw)
        {
            return true;
        }
        idx += 1;
    }
    false
}

fn has_ticket_after_keyword(bytes: &[u8], after_kw: usize) -> bool {
    let len = bytes.len();
    let mut cursor = after_kw;
    while cursor < len && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if !matches!(bytes.get(cursor), Some(b'(' | b'[' | b':')) {
        return false;
    }
    cursor += 1;
    while cursor < len && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    starts_with_ticket_id(&bytes[cursor..])
}

fn match_todo_keyword(bytes: &[u8], idx: usize) -> Option<usize> {
    if idx > 0 && (bytes[idx - 1].is_ascii_alphanumeric() || bytes[idx - 1] == b'_') {
        return None;
    }
    for kw in ["todo", "fixme", "hack"] {
        let end = idx + kw.len();
        if end <= bytes.len() && bytes[idx..end].eq_ignore_ascii_case(kw.as_bytes()) {
            return Some(end);
        }
    }
    None
}

fn starts_with_ticket_id(bytes: &[u8]) -> bool {
    let alpha_len = bytes.iter().take_while(|b| b.is_ascii_alphabetic()).count();
    if alpha_len < 2 || bytes.get(alpha_len) != Some(&b'-') {
        return false;
    }
    let digit_start = alpha_len + 1;
    bytes.get(digit_start).is_some_and(u8::is_ascii_digit)
}
