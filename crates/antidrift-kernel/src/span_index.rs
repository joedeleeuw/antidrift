use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticLocation {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[must_use]
pub fn line_terminator_len(bytes: &[u8]) -> Option<usize> {
    match bytes {
        [b'\r', b'\n', ..] => Some(2),
        [b'\n' | b'\r', ..] => Some(1),
        [0xE2, 0x80, 0xA8 | 0xA9, ..] => Some(3),
        _ => None,
    }
}

#[must_use]
pub fn split_first_line(text: &str) -> (&str, Option<&str>) {
    let bytes = text.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        if let Some(len) = line_terminator_len(&bytes[idx..]) {
            return (&text[..idx], Some(&text[idx + len..]));
        }
        idx += 1;
    }
    (text, None)
}

pub fn split_ecma_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut remaining = (!text.is_empty()).then_some(text);
    std::iter::from_fn(move || {
        let current = remaining.take()?;
        let (line, rest) = split_first_line(current);
        remaining = rest.filter(|tail| !tail.is_empty());
        Some(line)
    })
}

#[derive(Debug, Clone)]
pub struct LineIndex {
    starts: Vec<u32>,
}

impl LineIndex {
    #[must_use]
    pub fn new(source_text: &str) -> Self {
        let mut starts = vec![0];
        let bytes = source_text.as_bytes();
        let mut idx = 0;
        while idx < bytes.len() {
            if let Some(len) = line_terminator_len(&bytes[idx..]) {
                idx += len;
                starts.push(u32::try_from(idx).unwrap_or(u32::MAX));
            } else {
                idx += 1;
            }
        }
        Self { starts }
    }

    #[must_use]
    pub fn line_col_zero_based(&self, source_text: &str, offset: u32) -> (u32, u32) {
        let clamped = usize::try_from(offset)
            .unwrap_or(source_text.len())
            .min(source_text.len());
        let clamped_u32 = u32::try_from(clamped).unwrap_or(u32::MAX);
        let line_idx = match self.starts.binary_search(&clamped_u32) {
            Ok(exact) => exact,
            Err(insert) => insert.saturating_sub(1),
        };
        let line_start = usize::try_from(self.starts[line_idx]).unwrap_or(0);
        let slice = source_text.get(line_start..clamped).unwrap_or("");
        let utf16_col = u32::try_from(slice.encode_utf16().count()).unwrap_or(0);
        let one_based_line = u32::try_from(line_idx.saturating_add(1)).unwrap_or(1);
        (one_based_line, utf16_col)
    }

    #[must_use]
    pub fn diagnostic_location(
        &self,
        source_text: &str,
        start: u32,
        end: u32,
    ) -> DiagnosticLocation {
        let (line, col0) = self.line_col_zero_based(source_text, start);
        let (end_line, end_col0) = self.line_col_zero_based(source_text, end);
        DiagnosticLocation {
            line,
            column: col0.saturating_add(1),
            end_line,
            end_column: end_col0.saturating_add(1),
        }
    }
}
