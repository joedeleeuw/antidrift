use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticLocation {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone)]
pub struct LineIndex {
    line_starts: Vec<u32>,
}

impl LineIndex {
    #[must_use]
    pub fn new(source_text: &str) -> Self {
        let mut line_starts = vec![0];
        for (idx, byte) in source_text.bytes().enumerate() {
            if byte == b'\n' {
                let next = u32::try_from(idx.saturating_add(1)).unwrap_or(u32::MAX);
                line_starts.push(next);
            }
        }
        Self { line_starts }
    }

    #[must_use]
    pub fn line_col_zero_based(&self, source_text: &str, offset: u32) -> (u32, u32) {
        let clamped = usize::try_from(offset)
            .unwrap_or(source_text.len())
            .min(source_text.len());
        let clamped_u32 = u32::try_from(clamped).unwrap_or(u32::MAX);
        let line_idx = match self.line_starts.binary_search(&clamped_u32) {
            Ok(exact) => exact,
            Err(insert) => insert.saturating_sub(1),
        };
        let line_start = usize::try_from(self.line_starts[line_idx]).unwrap_or(0);
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
