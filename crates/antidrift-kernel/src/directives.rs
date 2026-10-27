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
