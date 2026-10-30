use super::RustDiagnostic;
use antidrift_kernel::line_caps::CappedUnit;
use std::path::Path;

const BANNED_EXACT_FILENAMES: &[&str] = &[
    "common.rs",
    "helpers.rs",
    "misc.rs",
    "shared.rs",
    "util.rs",
    "utils.rs",
];

const BANNED_SUFFIXES: &[&str] = &["_helpers.rs", "_utils.rs"];

pub(super) fn check_file_surface(
    rel_path: &str,
    path: &Path,
    source: &str,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    check_grab_bag_filename(rel_path, path, diagnostics);
    check_max_lines(rel_path, source, diagnostics);
    scan_inline_comments(rel_path, source, diagnostics);
}

fn check_grab_bag_filename(rel_path: &str, path: &Path, diagnostics: &mut Vec<RustDiagnostic>) {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let is_banned = BANNED_EXACT_FILENAMES.contains(&file_name)
        || BANNED_SUFFIXES
            .iter()
            .any(|suffix| file_name.ends_with(suffix));
    if is_banned {
        diagnostics.push(RustDiagnostic::error(
            rel_path.to_owned(),
            1,
            "rust/no-grab-bag-module",
            format!(
                "Module filename '{file_name}' is a grab-bag name; name the module after the domain concept it owns."
            ),
        ));
    }
}

fn check_max_lines(rel_path: &str, source: &str, diagnostics: &mut Vec<RustDiagnostic>) {
    let cap = CappedUnit::RustFile.cap();
    if let Some(finding) = cap.judge("File", source) {
        diagnostics.push(RustDiagnostic {
            file: rel_path.to_owned(),
            line: 1,
            rule_id: cap.rule_id,
            severity: finding.tier.severity(),
            message: finding.message,
        });
    }
}

pub(super) fn scan_inline_comments(
    rel_path: &str,
    source: &str,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut idx = 0;
    let mut line = 1usize;

    while idx < len {
        let byte = bytes[idx];
        if byte == b'\n' {
            line += 1;
            idx += 1;
            continue;
        }
        if let Some((next_idx, next_line)) = try_skip_raw_string(bytes, idx, line) {
            idx = next_idx;
            line = next_line;
            continue;
        }
        if byte == b'"' {
            let (next_idx, next_line) = skip_quoted_string(bytes, idx + 1, line);
            idx = next_idx;
            line = next_line;
            continue;
        }
        if byte == b'\'' {
            idx = skip_char_or_lifetime(source, bytes, idx);
            continue;
        }
        if byte == b'/' && idx + 1 < len && bytes[idx + 1] == b'/' {
            diagnostics.push(RustDiagnostic::error(
                rel_path.to_owned(),
                line,
                "rust/no-inline-comment",
                "Inline line comment is forbidden; put rationale in the commit body or type names."
                    .to_owned(),
            ));
            idx = skip_to_line_end(bytes, idx + 2);
            continue;
        }
        if byte == b'/' && idx + 1 < len && bytes[idx + 1] == b'*' {
            diagnostics.push(RustDiagnostic::error(
                rel_path.to_owned(),
                line,
                "rust/no-inline-comment",
                "Block comment is forbidden; put rationale in the commit body or type names."
                    .to_owned(),
            ));
            let (next_idx, next_line) = skip_block_comment(bytes, idx + 2, line);
            idx = next_idx;
            line = next_line;
            continue;
        }
        idx += 1;
    }
}

fn try_skip_raw_string(bytes: &[u8], idx: usize, line: usize) -> Option<(usize, usize)> {
    let r_pos = match bytes[idx] {
        b'r' => idx,
        b'b' | b'c' if bytes.get(idx + 1) == Some(&b'r') => idx + 1,
        _ => return None,
    };
    if idx > 0 && is_ident_continue(bytes[idx - 1]) {
        return None;
    }
    let mut cursor = r_pos + 1;
    let mut hashes = 0usize;
    while bytes.get(cursor) == Some(&b'#') {
        hashes += 1;
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'"') {
        return None;
    }
    cursor += 1;
    let mut current_line = line;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\n' {
            current_line += 1;
            cursor += 1;
            continue;
        }
        if bytes[cursor] == b'"' && has_closing_hashes(bytes, cursor + 1, hashes) {
            return Some((cursor + 1 + hashes, current_line));
        }
        cursor += 1;
    }
    Some((bytes.len(), current_line))
}

fn has_closing_hashes(bytes: &[u8], start: usize, hashes: usize) -> bool {
    if start + hashes > bytes.len() {
        return false;
    }
    bytes[start..start + hashes]
        .iter()
        .all(|&byte| byte == b'#')
}

fn is_ident_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn skip_quoted_string(bytes: &[u8], start: usize, start_line: usize) -> (usize, usize) {
    let mut idx = start;
    let mut line = start_line;
    while idx < bytes.len() {
        let byte = bytes[idx];
        if byte == b'\n' {
            line += 1;
            idx += 1;
        } else if byte == b'\\' {
            if idx + 1 < bytes.len() && bytes[idx + 1] == b'\n' {
                line += 1;
            }
            idx = (idx + 2).min(bytes.len());
        } else if byte == b'"' {
            return (idx + 1, line);
        } else {
            idx += 1;
        }
    }
    (bytes.len(), line)
}

fn skip_char_or_lifetime(source: &str, bytes: &[u8], idx: usize) -> usize {
    if bytes.get(idx + 1) == Some(&b'\\') {
        let mut cursor = idx + 2;
        while cursor < bytes.len() && bytes[cursor] != b'\n' {
            if bytes[cursor] == b'\'' {
                return cursor + 1;
            }
            cursor += 1;
        }
        return idx + 1;
    }
    let tail = &source[idx + 1..];
    let mut chars = tail.chars();
    let Some(first) = chars.next() else {
        return idx + 1;
    };
    if first == '\n' || first == '\'' {
        return idx + 1;
    }
    if chars.next() == Some('\'') {
        return idx + 1 + first.len_utf8() + 1;
    }
    idx + 1
}

fn skip_to_line_end(bytes: &[u8], start: usize) -> usize {
    let mut idx = start;
    while idx < bytes.len() && bytes[idx] != b'\n' {
        idx += 1;
    }
    idx
}

fn skip_block_comment(bytes: &[u8], start: usize, start_line: usize) -> (usize, usize) {
    let mut idx = start;
    let mut line = start_line;
    let mut depth = 1usize;
    while idx < bytes.len() && depth > 0 {
        if bytes[idx] == b'\n' {
            line += 1;
            idx += 1;
        } else if idx + 1 < bytes.len() && bytes[idx] == b'/' && bytes[idx + 1] == b'*' {
            depth += 1;
            idx += 2;
        } else if idx + 1 < bytes.len() && bytes[idx] == b'*' && bytes[idx + 1] == b'/' {
            depth -= 1;
            idx += 2;
        } else {
            idx += 1;
        }
    }
    (idx, line)
}
