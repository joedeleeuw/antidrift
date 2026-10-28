use antidrift_kernel::directives::scan_source_comments;
use antidrift_kernel::rule_scope::RuleScope;
use tsrs_ast::{Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, Listener, Rule, RuleMessage, RuleVisitor};

pub const RULE_NAME: &str = "antidrift/no-dated-comments";

pub struct NoDatedComments {
    scope: RuleScope,
}

pub static DEFAULT_RULE: NoDatedComments = NoDatedComments {
    scope: RuleScope::DEFAULT,
};

impl NoDatedComments {
    pub fn from_options(options: Option<&serde_json::Value>) -> Result<Self, String> {
        Ok(Self {
            scope: RuleScope::from_options(RULE_NAME, options)?,
        })
    }
}

const LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

impl Rule for NoDatedComments {
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
        let source_text = ctx.file.text();
        for comment in scan_source_comments(source_text) {
            let value = comment.raw_content;
            if value.contains("@example") || value.contains("```") {
                continue;
            }
            let comment_start = usize::try_from(comment.pos.max(0)).unwrap_or(0);
            if trails_code(comment_start, source_text) {
                continue;
            }
            let scrubbed = strip_quoted_and_urls(value);
            if contains_iso_date(&scrubbed) {
                ctx.report_range(
                    comment.pos,
                    comment.end,
                    RuleMessage::new(
                        "datedComment",
                        "Dated provenance prose in a comment. History belongs in commit bodies and field notes, not in code.",
                    ),
                );
            }
        }
    }
}

fn trails_code(comment_start: usize, source_text: &str) -> bool {
    let prefix = &source_text[..comment_start.min(source_text.len())];
    let line_start = prefix.rfind('\n').map_or(0, |pos| pos + 1);
    !prefix[line_start..].trim().is_empty()
}

fn strip_quoted_and_urls(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        let b = bytes[idx];
        if matches!(b, b'"' | b'`')
            && let Some(end) = find_closing_quote(bytes, idx + 1, b)
        {
            out.push(b' ');
            idx = end + 1;
            continue;
        }
        if b == b'\''
            && (idx == 0 || !bytes[idx - 1].is_ascii_alphabetic())
            && let Some(end) = find_closing_single_quote_span(bytes, idx + 1)
        {
            out.push(b' ');
            idx = end + 1;
            continue;
        }
        if idx + 3 < bytes.len()
            && bytes[idx] == b':'
            && bytes[idx + 1] == b'/'
            && bytes[idx + 2] == b'/'
        {
            while out
                .last()
                .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
            {
                out.pop();
            }
            idx += 3;
            while idx < bytes.len() && !bytes[idx].is_ascii_whitespace() {
                idx += 1;
            }
            out.push(b' ');
            continue;
        }
        out.push(b);
        idx += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn find_closing_quote(bytes: &[u8], start: usize, quote: u8) -> Option<usize> {
    let mut idx = start;
    while idx < bytes.len() && bytes[idx] != b'\n' {
        if bytes[idx] == quote {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn find_closing_single_quote_span(bytes: &[u8], start: usize) -> Option<usize> {
    let end = find_closing_quote(bytes, start, b'\'')?;
    if end + 1 >= bytes.len() || !bytes[end + 1].is_ascii_alphabetic() {
        Some(end)
    } else {
        None
    }
}

fn contains_iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    for idx in 0..bytes.len() {
        if idx > 0 && is_word_or_hyphen(bytes[idx - 1]) {
            continue;
        }
        if let Some(end) = match_iso_date_at(bytes, idx) {
            if end < bytes.len() && is_word_or_hyphen(bytes[end]) {
                continue;
            }
            if has_following_time(&bytes[end..]) {
                continue;
            }
            return true;
        }
    }
    false
}

fn is_word_or_hyphen(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn match_iso_date_at(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start..start + 2) != Some(b"20") {
        return None;
    }
    if !bytes.get(start + 2).is_some_and(u8::is_ascii_digit)
        || !bytes.get(start + 3).is_some_and(u8::is_ascii_digit)
    {
        return None;
    }
    let mut pos = start + 4;
    if bytes.get(pos) == Some(&b'-') {
        pos += 1;
    }
    if !matches!(bytes.get(pos), Some(b'0' | b'1'))
        || !bytes.get(pos + 1).is_some_and(u8::is_ascii_digit)
    {
        return None;
    }
    pos += 2;
    if bytes.get(pos) == Some(&b'-') {
        pos += 1;
    }
    if !matches!(bytes.get(pos), Some(b'0'..=b'3'))
        || !bytes.get(pos + 1).is_some_and(u8::is_ascii_digit)
    {
        return None;
    }
    Some(pos + 2)
}

fn has_following_time(rest: &[u8]) -> bool {
    if rest.first() != Some(&b' ') {
        return false;
    }
    let digits = rest[1..]
        .iter()
        .take(2)
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digits == 0 {
        return false;
    }
    let colon_pos = 1 + digits;
    rest.get(colon_pos) == Some(&b':')
        && rest.get(colon_pos + 1).is_some_and(u8::is_ascii_digit)
        && rest.get(colon_pos + 2).is_some_and(u8::is_ascii_digit)
}
