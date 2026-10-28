use crate::diagnostic::{RuleDiagnostic, Severity};
use crate::span_index::LineIndex;
use oxc::ast::Comment;
use oxc::span::Span;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectiveKind {
    DisableBlock,
    EnableBlock,
    DisableLine,
    DisableNextLine,
}

#[derive(Debug, Clone)]
struct ParsedDirective {
    kind: DirectiveKind,
    line: u32,
    span: Span,
    rules: Vec<String>,
    matched: bool,
}

#[derive(Debug, Clone)]
pub struct DirectiveSet {
    directives: Vec<ParsedDirective>,
}

impl DirectiveSet {
    #[must_use]
    pub fn from_comments(comments: &[Comment], source_text: &str, line_index: &LineIndex) -> Self {
        let mut directives = Vec::new();
        for comment in comments {
            let text = source_text
                .get(comment.content_span().start as usize..comment.content_span().end as usize)
                .unwrap_or("")
                .trim();
            if let Some((kind, rules)) = parse_directive_text(text) {
                let (line, _) = line_index.line_col_zero_based(source_text, comment.span.start);
                directives.push(ParsedDirective {
                    kind,
                    line,
                    span: comment.span,
                    rules,
                    matched: false,
                });
            }
        }
        Self { directives }
    }

    pub fn filter_diagnostics(
        &mut self,
        diagnostics: Vec<RuleDiagnostic>,
        report_unused: bool,
        source_text: &str,
        line_index: &LineIndex,
    ) -> Vec<RuleDiagnostic> {
        let mut retained = Vec::with_capacity(diagnostics.len());
        for diag in diagnostics {
            if self.suppresses(&diag.rule_id, diag.location.line) {
                continue;
            }
            retained.push(diag);
        }
        if report_unused {
            self.append_unused_directive_diagnostics(&mut retained, source_text, line_index);
        }
        retained
    }

    fn append_unused_directive_diagnostics(
        &self,
        retained: &mut Vec<RuleDiagnostic>,
        source_text: &str,
        line_index: &LineIndex,
    ) {
        for directive in &self.directives {
            if directive.matched || matches!(directive.kind, DirectiveKind::EnableBlock) {
                continue;
            }
            retained.push(RuleDiagnostic {
                rule_id: "unused-disable-directive".to_string(),
                message_id: Some("unusedDisableDirective".to_string()),
                message: "Unused inline disable directive.".to_string(),
                severity: Severity::Error,
                span: directive.span,
                location: line_index.diagnostic_location(source_text, directive.span),
                fix: None,
            });
        }
    }

    fn suppresses(&mut self, rule_id: &str, diagnostic_line: u32) -> bool {
        let mut active_block_index: Option<usize> = None;
        for (idx, directive) in self.directives.iter().enumerate() {
            if !directive_applies_to_rule(&directive.rules, rule_id) {
                continue;
            }
            match directive.kind {
                DirectiveKind::DisableBlock if directive.line <= diagnostic_line => {
                    active_block_index = Some(idx);
                }
                DirectiveKind::EnableBlock if directive.line <= diagnostic_line => {
                    active_block_index = None;
                }
                DirectiveKind::DisableLine if directive.line == diagnostic_line => {
                    self.directives[idx].matched = true;
                    return true;
                }
                DirectiveKind::DisableNextLine
                    if directive.line.saturating_add(1) == diagnostic_line =>
                {
                    self.directives[idx].matched = true;
                    return true;
                }
                _ => {}
            }
        }
        if let Some(idx) = active_block_index {
            self.directives[idx].matched = true;
            return true;
        }
        false
    }
}

fn directive_applies_to_rule(rules: &[String], rule_id: &str) -> bool {
    if rules.is_empty() {
        return true;
    }
    let short = rule_id.strip_prefix("antidrift/").unwrap_or(rule_id);
    rules.iter().any(|entry| entry == rule_id || entry == short)
}

fn parse_directive_text(text: &str) -> Option<(DirectiveKind, Vec<String>)> {
    let before_description = text.split("--").next().unwrap_or(text).trim();
    let mut parts = before_description.splitn(2, char::is_whitespace);
    let prefix = parts.next()?;
    let kind = match prefix {
        "eslint-disable" | "oxlint-disable" => DirectiveKind::DisableBlock,
        "eslint-enable" | "oxlint-enable" => DirectiveKind::EnableBlock,
        "eslint-disable-line" | "oxlint-disable-line" => DirectiveKind::DisableLine,
        "eslint-disable-next-line" | "oxlint-disable-next-line" => DirectiveKind::DisableNextLine,
        _ => return None,
    };
    let rest = parts.next().unwrap_or("").trim();
    let rules = rest
        .split([',', ' ', '\t'])
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    Some((kind, rules))
}

fn skip_leading_trivia(source_text: &str, start: usize, end: usize) -> usize {
    let bytes = source_text.as_bytes();
    let limit = end.min(bytes.len());
    let mut pos = start.min(limit);
    while pos < limit {
        while pos < limit && matches!(bytes[pos], b' ' | b'\t' | b'\r' | b'\n') {
            pos += 1;
        }
        if pos + 1 < limit && bytes[pos] == b'/' && bytes[pos + 1] == b'/' {
            pos += 2;
            while pos < limit && bytes[pos] != b'\n' {
                pos += 1;
            }
        } else if pos + 1 < limit && bytes[pos] == b'/' && bytes[pos + 1] == b'*' {
            pos += 2;
            while pos + 1 < limit && !(bytes[pos] == b'*' && bytes[pos + 1] == b'/') {
                pos += 1;
            }
            pos = (pos + 2).min(limit);
        } else {
            break;
        }
    }
    pos
}

fn skip_quoted_literal(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut idx = start + 1;
    while idx < bytes.len() && bytes[idx] != quote && bytes[idx] != b'\n' {
        idx = if bytes[idx] == b'\\' {
            (idx + 2).min(bytes.len())
        } else {
            idx + 1
        };
    }
    if idx < bytes.len() && bytes[idx] == quote {
        idx + 1
    } else {
        idx
    }
}

fn skip_template_literal(bytes: &[u8], start: usize, line: &mut usize) -> usize {
    let mut idx = start + 1;
    while idx < bytes.len() && bytes[idx] != b'`' {
        if bytes[idx] == b'\\' {
            if idx + 1 < bytes.len() && bytes[idx + 1] == b'\n' {
                *line += 1;
            }
            idx = (idx + 2).min(bytes.len());
            continue;
        }
        if bytes[idx] == b'\n' {
            *line += 1;
        }
        idx += 1;
    }
    (idx + 1).min(bytes.len())
}

fn read_block_comment<'a>(
    source_text: &'a str,
    start: usize,
    line: &mut usize,
) -> (usize, Option<&'a str>) {
    let bytes = source_text.as_bytes();
    let content_start = start + 2;
    let mut idx = content_start;
    while idx + 1 < bytes.len() && !(bytes[idx] == b'*' && bytes[idx + 1] == b'/') {
        if bytes[idx] == b'\n' {
            *line += 1;
        }
        idx += 1;
    }
    let text = source_text.get(content_start..idx).map(str::trim);
    ((idx + 2).min(bytes.len()), text)
}

fn scan_comments_until_line(source_text: &str, max_line: usize) -> Vec<(usize, &str)> {
    let bytes = source_text.as_bytes();
    let mut idx = 0_usize;
    let mut line = 0_usize;
    let mut comments = Vec::new();
    while idx < bytes.len() && line <= max_line {
        match bytes[idx] {
            b'\n' => {
                line += 1;
                idx += 1;
            }
            b'\'' | b'"' => {
                idx = skip_quoted_literal(bytes, idx, bytes[idx]);
            }
            b'`' => {
                idx = skip_template_literal(bytes, idx, &mut line);
            }
            b'/' if idx + 1 < bytes.len() && bytes[idx + 1] == b'/' => {
                let start = idx + 2;
                idx += 2;
                while idx < bytes.len() && bytes[idx] != b'\n' {
                    idx += 1;
                }
                if let Some(text) = source_text.get(start..idx) {
                    comments.push((line, text.trim()));
                }
            }
            b'/' if idx + 1 < bytes.len() && bytes[idx + 1] == b'*' => {
                let (next_idx, text) = read_block_comment(source_text, idx, &mut line);
                if let Some(trimmed) = text {
                    comments.push((line, trimmed));
                }
                idx = next_idx;
            }
            _ => {
                idx += 1;
            }
        }
    }
    comments
}

#[must_use]
pub fn is_inline_disabled(source_text: &str, pos: i32, end: i32, rule_id: &str) -> bool {
    let start_offset = usize::try_from(pos.max(0)).unwrap_or(0);
    let end_offset = usize::try_from(end.max(0)).unwrap_or(0);
    let token_pos = skip_leading_trivia(source_text, start_offset, end_offset);
    let prefix = source_text.get(..token_pos).unwrap_or(source_text);
    let target_line = prefix.bytes().filter(|&ch| ch == b'\n').count();
    let mut block_disabled = false;
    for (comment_line, comment_text) in scan_comments_until_line(source_text, target_line) {
        let Some((kind, rules)) = parse_directive_text(comment_text) else {
            continue;
        };
        if !directive_applies_to_rule(&rules, rule_id) {
            continue;
        }
        match kind {
            DirectiveKind::DisableNextLine if comment_line + 1 == target_line => return true,
            DirectiveKind::DisableLine if comment_line == target_line => return true,
            DirectiveKind::DisableBlock if comment_line <= target_line => block_disabled = true,
            DirectiveKind::EnableBlock if comment_line <= target_line => block_disabled = false,
            _ => {}
        }
    }
    block_disabled
}
