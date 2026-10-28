use std::sync::{Arc, Mutex};

use rustc_hash::FxHashMap;
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, new_compiler_host};
use tsrs_core::P;
use tsrs_core::tspath::{self, Path};
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::overlayfs::OverlayFS;
use tsrslint::protocol::{Diagnostic, Payload};
use tsrslint::tsconfig::ExtendedConfigCache;

pub(crate) type DeclarationCache = Mutex<FxHashMap<SourceFileParseOptions, P<SourceFile>>>;

struct ProgramExtCache(&'static ExtendedConfigCache);

impl tsrs_tsoptions::ExtendedConfigCache for ProgramExtCache {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &Path,
        resolution_stack: &[Path],
        host: &'static dyn tsrs_tsoptions::ParseConfigHost,
    ) -> P<tsrs_tsoptions::ExtendedConfigCacheEntry> {
        self.0
            .get_extended_config(file_name, path, resolution_stack, host)
    }
}

struct SharedDeclarationsHost {
    inner: Arc<dyn CompilerHost>,
    cache: &'static DeclarationCache,
}

impl CompilerHost for SharedDeclarationsHost {
    fn fs(&self) -> &dyn FS {
        self.inner.fs()
    }

    fn default_library_path(&self) -> &str {
        self.inner.default_library_path()
    }

    fn get_current_directory(&self) -> &str {
        self.inner.get_current_directory()
    }

    fn trace(&self, msg: &'static tsrs_diagnostics::Message, args: &[&dyn std::fmt::Display]) {
        self.inner.trace(msg, args);
    }

    fn get_source_file(&self, opts: SourceFileParseOptions) -> Option<P<SourceFile>> {
        if !tspath::is_declaration_file_name(&opts.file_name)
            && !tspath::file_extension_is(&opts.file_name, tspath::EXTENSION_JSON)
        {
            return self.inner.get_source_file(opts);
        }
        if let Ok(guard) = self.cache.lock()
            && let Some(&file) = guard.get(&opts)
        {
            return Some(file);
        }
        let file = self.inner.get_source_file(opts.clone())?;
        if let Ok(mut guard) = self.cache.lock() {
            return Some(*guard.entry(opts).or_insert(file));
        }
        Some(file)
    }

    fn get_content_mapped_source_files(
        &self,
        opts: SourceFileParseOptions,
        mapper: &tsrs_contentmapper::Mapper,
    ) -> Result<tsrs_contentmapper::SourceFiles, tsrs_contentmapper::Error> {
        self.inner.get_content_mapped_source_files(opts, mapper)
    }

    fn content_mapper_project(&self) -> Option<Arc<dyn tsrs_contentmapper::Project>> {
        self.inner.content_mapper_project()
    }

    fn get_resolved_project_reference(
        &self,
        file_name: &str,
        path: Path,
    ) -> Option<P<tsrs_tsoptions::ParsedCommandLine>> {
        self.inner.get_resolved_project_reference(file_name, path)
    }
}

pub(crate) fn base_fs(payload: &Payload) -> Arc<dyn FS> {
    let os_fs: Arc<dyn FS> = Arc::new(osvfs::fs());
    let base: Arc<dyn FS> = match &payload.source_overrides {
        Some(overrides) if !overrides.is_empty() => {
            Arc::new(OverlayFS::new(os_fs, overrides.clone()))
        }
        _ => os_fs,
    };
    Arc::new(bundled::wrap_fs(cachedvfs::from(base)))
}

pub(crate) fn build_shared_host(
    dir: &str,
    fs: &Arc<dyn FS>,
    ext_cache: &'static ExtendedConfigCache,
    declarations: &'static DeclarationCache,
) -> Arc<dyn CompilerHost> {
    let inner = new_compiler_host(
        dir,
        Arc::clone(fs),
        &bundled::lib_path(),
        Some(Arc::new(ProgramExtCache(ext_cache))),
        None,
        None,
    );
    Arc::new(SharedDeclarationsHost {
        inner,
        cache: declarations,
    })
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

fn directive_matches_rule(rest: &str, rule_id: &str) -> bool {
    let before_desc = rest.split("--").next().unwrap_or(rest).trim();
    let tokens: Vec<&str> = before_desc
        .split([',', ' ', '\t'])
        .map(str::trim)
        .filter(|tok| !tok.is_empty())
        .collect();
    if tokens.is_empty() {
        return true;
    }
    let short = rule_id.strip_prefix("antidrift/").unwrap_or(rule_id);
    tokens.iter().any(|&tok| tok == rule_id || tok == short)
}

fn extract_line_comment(line: &str) -> Option<&str> {
    if let Some((_, after)) = line.split_once("//") {
        return Some(after.trim());
    }
    if let Some((_, after_open)) = line.split_once("/*") {
        let content = after_open
            .split_once("*/")
            .map_or(after_open, |(inner, _)| inner);
        return Some(content.trim());
    }
    None
}

pub(crate) fn is_inline_disabled(source_text: &str, pos: i32, end: i32, rule_id: &str) -> bool {
    let start_offset = usize::try_from(pos.max(0)).unwrap_or(0);
    let end_offset = usize::try_from(end.max(0)).unwrap_or(0);
    let token_pos = skip_leading_trivia(source_text, start_offset, end_offset);
    let prefix = source_text.get(..token_pos).unwrap_or(source_text);
    let target_line = prefix.bytes().filter(|&ch| ch == b'\n').count();
    let mut block_disabled = false;
    for (line_idx, line) in source_text.lines().take(target_line + 1).enumerate() {
        let Some(comment) = extract_line_comment(line) else {
            continue;
        };
        let mut parts = comment.splitn(2, char::is_whitespace);
        let Some(directive) = parts.next() else {
            continue;
        };
        let rest = parts.next().unwrap_or("");
        if !directive_matches_rule(rest, rule_id) {
            continue;
        }
        match directive {
            "eslint-disable-next-line" | "oxlint-disable-next-line"
                if line_idx + 1 == target_line =>
            {
                return true;
            }
            "eslint-disable-line" | "oxlint-disable-line" if line_idx == target_line => {
                return true;
            }
            "eslint-disable" | "oxlint-disable" if line_idx <= target_line => {
                block_disabled = true;
            }
            "eslint-enable" | "oxlint-enable" if line_idx <= target_line => {
                block_disabled = false;
            }
            _ => {}
        }
    }
    block_disabled
}

pub(crate) fn filter_suppressed_diagnostics(
    cwd: &str,
    diagnostics: Vec<Diagnostic>,
) -> Result<Vec<Diagnostic>, String> {
    let path = std::path::Path::new(cwd).join("eslint-suppressions.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(diagnostics),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| format!("failed to parse {}: {err}", path.display()))?;
    let Some(suppressions) = parsed.as_object() else {
        return Err(format!("invalid {}: expected JSON object", path.display()));
    };
    let mut counts: FxHashMap<(String, String), usize> = FxHashMap::default();
    for diag in &diagnostics {
        if let Some(fp) = &diag.file_path {
            let rel = antidrift_kernel::provenance::relative_to_cwd(cwd, fp);
            *counts.entry((rel, diag.message.id.clone())).or_insert(0) += 1;
        }
    }
    Ok(diagnostics
        .into_iter()
        .filter(|diag| {
            let Some(fp) = &diag.file_path else {
                return true;
            };
            let rel = antidrift_kernel::provenance::relative_to_cwd(cwd, fp);
            let allowed = suppressions
                .get(&rel)
                .and_then(|file_map| file_map.get(&diag.message.id))
                .and_then(|entry| entry.get("count"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|val| usize::try_from(val).ok())
                .unwrap_or(0);
            if allowed == 0 {
                return true;
            }
            let actual = counts
                .get(&(rel, diag.message.id.clone()))
                .copied()
                .unwrap_or(0);
            actual > allowed
        })
        .collect())
}
