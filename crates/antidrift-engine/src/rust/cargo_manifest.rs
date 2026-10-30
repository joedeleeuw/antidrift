use super::RustDiagnostic;
use rustc_hash::FxHashMap;
use std::path::Path;

pub(super) fn check_cargo_manifest(
    manifest_rel: &str,
    crate_dir: &Path,
    sections: &[TomlSection],
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    let has_workspace_lints = sections.iter().any(|sec| {
        (sec.header == "[lints]"
            && sec
                .kv
                .get("workspace")
                .is_some_and(|setting| setting == "true"))
            || (sec.header.is_empty()
                && sec
                    .kv
                    .get("lints.workspace")
                    .is_some_and(|setting| setting == "true"))
    });
    if !has_workspace_lints {
        diagnostics.push(RustDiagnostic::error(
            manifest_rel.to_owned(),
            1,
            "rust/target-manifest-policy",
            "Crate Cargo.toml must inherit `[lints] workspace = true`.".to_owned(),
        ));
    }

    for sec in sections {
        if matches!(sec.header.as_str(), "[lib]" | "[[bin]]") {
            if sec.kv.get("test") != Some(&"false".to_owned()) {
                diagnostics.push(RustDiagnostic::error(
                    manifest_rel.to_owned(),
                    sec.line,
                    "rust/target-manifest-policy",
                    format!("Section {} must set `test = false`.", sec.header),
                ));
            }
            if sec.kv.get("doctest") != Some(&"false".to_owned()) {
                diagnostics.push(RustDiagnostic::error(
                    manifest_rel.to_owned(),
                    sec.line,
                    "rust/target-manifest-policy",
                    format!("Section {} must set `doctest = false`.", sec.header),
                ));
            }
        }
    }

    let crate_name = crate_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    for sec in sections {
        if sec.header == "[dependencies]" {
            check_dependency_dag(manifest_rel, crate_name, sec, diagnostics);
        }
    }
}

fn check_dependency_dag(
    manifest_rel: &str,
    crate_name: &str,
    sec: &TomlSection,
    diagnostics: &mut Vec<RustDiagnostic>,
) {
    if crate_name == "antidrift-kernel" {
        for forbidden in ["antidrift-rules", "antidrift-engine"] {
            if sec
                .kv
                .keys()
                .any(|key| key.split('.').next() == Some(forbidden))
            {
                diagnostics.push(RustDiagnostic::error(
                    manifest_rel.to_owned(),
                    sec.line,
                    "rust/target-manifest-policy",
                    format!("antidrift-kernel cannot depend on {forbidden}."),
                ));
            }
        }
    } else if crate_name == "antidrift-rules"
        && sec
            .kv
            .keys()
            .any(|key| key.split('.').next() == Some("antidrift-engine"))
    {
        diagnostics.push(RustDiagnostic::error(
            manifest_rel.to_owned(),
            sec.line,
            "rust/target-manifest-policy",
            "antidrift-rules cannot depend on antidrift-engine.".to_owned(),
        ));
    }
}

pub(super) struct TomlSection {
    pub(super) header: String,
    line: usize,
    pub(super) kv: FxHashMap<String, String>,
}

pub(super) fn parse_toml_sections(text: &str) -> Vec<TomlSection> {
    let mut sections = Vec::new();
    let mut current = TomlSection {
        header: String::new(),
        line: 1,
        kv: FxHashMap::default(),
    };
    for (idx, raw_line) in text.lines().enumerate() {
        let trimmed = without_toml_comment(raw_line).trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if !current.header.is_empty() || !current.kv.is_empty() {
                sections.push(current);
            }
            current = TomlSection {
                header: trimmed.to_owned(),
                line: idx + 1,
                kv: FxHashMap::default(),
            };
        } else if let Some((raw_key, raw_val)) = trimmed.split_once('=') {
            let key = raw_key.trim();
            current.kv.insert(key.to_owned(), raw_val.trim().to_owned());
        }
    }
    if !current.header.is_empty() || !current.kv.is_empty() {
        sections.push(current);
    }
    sections
}

fn without_toml_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quote == Some('"') => escaped = true,
            '\'' | '"' if quote == Some(ch) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(ch),
            '#' if quote.is_none() => return &line[..offset],
            _ => {}
        }
    }
    line
}
