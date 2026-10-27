use crate::span_index::DiagnosticLocation;
use oxc::span::Span;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Off,
    Warn,
    Error,
}

impl Severity {
    #[must_use]
    pub const fn eslint_code(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Warn => 1,
            Self::Error => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

impl TextEdit {
    #[must_use]
    pub fn replace(span: Span, text: impl Into<String>) -> Self {
        Self {
            start: span.start,
            end: span.end,
            text: text.into(),
        }
    }

    #[must_use]
    pub fn remove(span: Span) -> Self {
        Self {
            start: span.start,
            end: span.end,
            text: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFix {
    pub edits: Vec<TextEdit>,
}

impl RuleFix {
    #[must_use]
    pub fn single(edit: TextEdit) -> Self {
        Self { edits: vec![edit] }
    }

    #[must_use]
    pub fn multi(edits: Vec<TextEdit>) -> Self {
        Self { edits }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDiagnostic {
    pub rule_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub message: String,
    pub severity: Severity,
    #[serde(skip)]
    pub span: Span,
    pub location: DiagnosticLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<RuleFix>,
}

#[must_use]
pub fn apply_fixes(source_text: &str, diagnostics: &[RuleDiagnostic]) -> Option<String> {
    let mut candidate_edits: Vec<&TextEdit> = Vec::new();
    for diag in diagnostics {
        if let Some(fix) = &diag.fix {
            for edit in &fix.edits {
                candidate_edits.push(edit);
            }
        }
    }
    if candidate_edits.is_empty() {
        return None;
    }
    candidate_edits.sort_by_key(|edit| (edit.start, edit.end));
    let mut accepted: Vec<&TextEdit> = Vec::with_capacity(candidate_edits.len());
    let mut last_end = 0_u32;
    for edit in candidate_edits {
        if edit.start >= last_end && edit.end >= edit.start {
            last_end = edit.end;
            accepted.push(edit);
        }
    }
    if accepted.is_empty() {
        return None;
    }
    let mut output = String::with_capacity(source_text.len());
    let mut cursor = 0_usize;
    for edit in accepted {
        let start = usize::try_from(edit.start).unwrap_or(source_text.len());
        let end = usize::try_from(edit.end).unwrap_or(source_text.len());
        if start < cursor || end > source_text.len() {
            continue;
        }
        output.push_str(source_text.get(cursor..start).unwrap_or(""));
        output.push_str(&edit.text);
        cursor = end;
    }
    output.push_str(source_text.get(cursor..).unwrap_or(""));
    Some(output)
}
