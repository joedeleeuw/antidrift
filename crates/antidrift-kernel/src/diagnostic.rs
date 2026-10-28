use crate::span_index::DiagnosticLocation;
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextEdit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleFix {
    pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleDiagnostic {
    pub rule_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub message: String,
    pub severity: Severity,
    pub location: DiagnosticLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<RuleFix>,
}

#[must_use]
pub fn apply_fixes(source_text: &str, diagnostics: &[RuleDiagnostic]) -> Option<String> {
    let mut accepted: Vec<&TextEdit> = Vec::new();
    for diag in diagnostics {
        let Some(fix) = &diag.fix else {
            continue;
        };
        let Some(valid_group) = validate_fix_edits(source_text, &fix.edits, &accepted) else {
            continue;
        };
        accepted.extend(valid_group);
        accepted.sort_by_key(|edit| (edit.start, edit.end));
    }
    if accepted.is_empty() {
        return None;
    }
    let mut output = String::with_capacity(source_text.len());
    let mut cursor = 0_usize;
    for edit in accepted {
        let Ok(start) = usize::try_from(edit.start) else {
            return None;
        };
        let Ok(end) = usize::try_from(edit.end) else {
            return None;
        };
        let prefix = source_text.get(cursor..start)?;
        output.push_str(prefix);
        output.push_str(&edit.text);
        cursor = end;
    }
    let tail = source_text.get(cursor..)?;
    output.push_str(tail);
    Some(output)
}

fn validate_fix_edits<'a>(
    source_text: &str,
    edits: &'a [TextEdit],
    existing: &[&'a TextEdit],
) -> Option<Vec<&'a TextEdit>> {
    if edits.is_empty() {
        return None;
    }
    let mut sorted: Vec<&'a TextEdit> = edits.iter().collect();
    sorted.sort_by_key(|edit| (edit.start, edit.end));
    let mut prev_end = 0_u32;
    for (idx, edit) in sorted.iter().enumerate() {
        let Ok(start) = usize::try_from(edit.start) else {
            return None;
        };
        let Ok(end) = usize::try_from(edit.end) else {
            return None;
        };
        if edit.end < edit.start
            || end > source_text.len()
            || !source_text.is_char_boundary(start)
            || !source_text.is_char_boundary(end)
        {
            return None;
        }
        if idx > 0 && edit.start < prev_end {
            return None;
        }
        if existing
            .iter()
            .any(|other| !(edit.end <= other.start || edit.start >= other.end))
        {
            return None;
        }
        prev_end = edit.end;
    }
    Some(sorted)
}
