use antidrift_kernel::directives::{scan_source_comments, split_identifier_words};
use antidrift_kernel::file_role::{FileRole, ProjectPath};
use antidrift_kernel::rule::{Ctx, Listener, RuleMessage, RuleSpec};
use tsrs_ast::{Kind, Node};
use tsrs_core::P;

const EOF_LISTENERS: &[Listener] = &[Listener::Enter(Kind::EndOfFile)];

const TUTORIAL_EXEMPT_ROLES: &[FileRole] =
    &[FileRole::TestOrSpec, FileRole::TestSupport, FileRole::Docs];
const LEAD_WORDS: &[&str] = &["this", "here", "we"];
const VERB_WORDS: &[&str] = &[
    "check",
    "checks",
    "ensure",
    "ensures",
    "handle",
    "handles",
    "return",
    "returns",
    "get",
    "gets",
    "set",
    "sets",
    "does",
    "validate",
    "validates",
];
const DIVIDER_CHARS: &[char] = &['=', '-', '*', '~'];
const HEADER_WORDS: &[&str] = &["copyright", "license", "spdx"];

pub static NO_DATED_COMMENTS: RuleSpec = RuleSpec::new(
    "antidrift/no-dated-comments",
    EOF_LISTENERS,
    visit_dated_comments,
);

pub static NO_TUTORIAL_COMMENTS: RuleSpec = RuleSpec::new(
    "antidrift/no-tutorial-comments",
    EOF_LISTENERS,
    visit_tutorial_comments,
);

fn visit_dated_comments(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
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

fn visit_tutorial_comments(ctx: &mut Ctx, _listener: Listener, _node: P<Node>) {
    let filename = ctx.file.file_name().replace('\\', "/");
    let path = ProjectPath::of(ctx.program, &filename);
    if path.has_any_role(TUTORIAL_EXEMPT_ROLES) {
        return;
    }
    for comment in scan_source_comments(ctx.file.text()) {
        let message = if is_tutorial_comment(comment.raw_content) {
            RuleMessage::new(
                "tutorial",
                "Tutorial-style explanatory comment detected. Remove the narration and keep the code direct.",
            )
        } else if !comment.is_block && is_section_divider(comment.text) {
            RuleMessage::new(
                "sectionDivider",
                "ASCII section-divider banner detected. Delete the banner; split the file along the seam it marks instead.",
            )
        } else {
            continue;
        };
        ctx.report_range(comment.pos, comment.end, message);
    }
}

fn is_tutorial_comment(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some(first_line) = trimmed.lines().next() else {
        return false;
    };
    let words: Vec<String> = split_identifier_words(first_line);
    let Some(first_word) = words.first() else {
        return false;
    };
    if !LEAD_WORDS.contains(&first_word.as_str()) {
        return false;
    }
    words
        .iter()
        .skip(1)
        .any(|word| VERB_WORDS.contains(&word.as_str()))
}

fn divider_run(mut chars: impl Iterator<Item = char>) -> usize {
    let Some(first) = chars.next().filter(|ch| DIVIDER_CHARS.contains(ch)) else {
        return 0;
    };
    1 + chars.take_while(|&ch| ch == first).count()
}

fn is_section_divider(text: &str) -> bool {
    if text.is_empty() || text.starts_with('/') || text.contains("://") || text.contains('|') {
        return false;
    }
    let lowered = text.to_ascii_lowercase();
    if HEADER_WORDS.iter().any(|word| lowered.contains(word)) {
        return false;
    }
    let divider_count = text.chars().filter(|ch| DIVIDER_CHARS.contains(ch)).count();
    if text
        .chars()
        .all(|ch| DIVIDER_CHARS.contains(&ch) || ch.is_whitespace())
    {
        return divider_count >= 8;
    }
    let (lead, trail) = (divider_run(text.chars()), divider_run(text.chars().rev()));
    if lead < 3 || trail < 3 {
        return false;
    }
    let label = text.get(lead..text.len() - trail).map_or("", str::trim);
    !label.is_empty() && label.len() <= 48 && !label.starts_with(DIVIDER_CHARS)
}
