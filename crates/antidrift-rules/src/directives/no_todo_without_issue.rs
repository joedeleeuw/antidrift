use antidrift_kernel::directives::{scan_source_comments, split_identifier_words};
use antidrift_kernel::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

pub const RULE_NAME: &str = "antidrift/no-todo-without-issue";

const DEBT_TOKENS: &[&str] = &["todo", "fixme", "hack", "temporary", "later", "cleanup"];
const BARE_TOKENS: &[&str] = &["todo", "fixme", "hack"];
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

pub struct NoTodoWithoutIssue;

pub static DEFAULT_RULE: NoTodoWithoutIssue = NoTodoWithoutIssue;

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoTodoWithoutIssue {
    fn name(&self) -> &'static str {
        RULE_NAME
    }

    fn create_visitor(&'static self, _ctx: &mut Ctx) -> Box<dyn RuleVisitor> {
        Box::new(Visitor)
    }
}

struct Visitor;

impl RuleVisitor for Visitor {
    fn listeners(&self) -> &[Listener] {
        LISTENERS
    }

    fn visit(&mut self, ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
        for comment in scan_source_comments(ctx.file.text()) {
            let text = if comment.is_lint_directive {
                scannable_directive_text(comment.text)
            } else {
                comment.raw_content.to_owned()
            };
            if has_tracked_ticket(&text) {
                continue;
            }
            let words = split_identifier_words(&text);
            let has_debt = unnegated_debt_token(&text, DEBT_TOKENS).is_some();
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
            if let Some(bare_token) = unnegated_debt_token(&text, BARE_TOKENS) {
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

fn scannable_directive_text(text: &str) -> String {
    let (rule_list, description) = text.split_once("--").unwrap_or((text, ""));
    let tokens = rule_list
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .filter(|token| !token.is_empty())
        .enumerate()
        .filter(|(index, token)| *index > 0 && !is_rule_id(token))
        .map(|(_, token)| token)
        .collect::<Vec<_>>()
        .join(" ");
    format!("{tokens} {description}")
}

fn is_rule_id(token: &str) -> bool {
    token.bytes().all(|byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'@' | b'/' | b'-' | b'_')
    })
}

fn unnegated_debt_token(text: &str, tokens: &[&str]) -> Option<String> {
    text.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let bytes = lower.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            if !bytes[start].is_ascii_alphanumeric() {
                start += 1;
                continue;
            }
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_alphanumeric() {
                end += 1;
            }
            let word = &lower[start..end];
            if tokens.contains(&word) && !negated_directly_before(bytes, start) {
                return Some(word.to_owned());
            }
            start = end;
        }
        None
    })
}

fn negated_directly_before(bytes: &[u8], token_start: usize) -> bool {
    let word_before = |end: usize| -> Option<(usize, &[u8])> {
        let mut start = end;
        while start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            start -= 1;
        }
        (start < end).then_some((start, &bytes[start..end]))
    };
    let skip_spaces = |mut idx: usize| -> usize {
        while idx > 0 && bytes[idx - 1].is_ascii_whitespace() {
            idx -= 1;
        }
        idx
    };
    let before_token = skip_spaces(token_start);
    if before_token == token_start {
        return false;
    }
    let Some((start, word)) = word_before(before_token) else {
        return false;
    };
    if word == b"not" {
        return true;
    }
    if word != b"a" {
        return false;
    }
    let before_article = skip_spaces(start);
    before_article < start && word_before(before_article).is_some_and(|(_, word)| word == b"not")
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
