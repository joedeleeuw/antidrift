use std::sync::{Arc, Mutex};

use rustc_hash::FxHashMap;
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, new_compiler_host};
use tsrs_core::tspath::{self, Path};
use tsrs_core::{
    CompilerOptions, JsxEmit, ModuleKind, ModuleResolutionKind, P, ScriptTarget, Tristate,
};
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::overlayfs::OverlayFS;
use tsrslint::protocol::{Diagnostic, Message, Payload, Range};
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

pub(crate) fn filter_suppressed_diagnostics(
    cwd: &str,
    diagnostics: Vec<Diagnostic>,
) -> Result<Vec<Diagnostic>, String> {
    let path = std::path::Path::new(cwd).join("eslint-suppressions.json");
    let suppressions = antidrift_kernel::suppressions::SuppressionsTable::load(&path)?;
    let mut seen_counts: FxHashMap<(String, String), usize> = FxHashMap::default();
    Ok(diagnostics
        .into_iter()
        .filter(|diag| {
            let Some(fp) = &diag.file_path else {
                return true;
            };
            let rel = antidrift_kernel::provenance::relative_to_cwd(cwd, fp);
            let allowed = suppressions.suppressed_count(&rel, &diag.message.id);
            if allowed == 0 {
                return true;
            }
            let seen = seen_counts
                .entry((rel, diag.message.id.clone()))
                .and_modify(|count| *count += 1)
                .or_insert(1);
            *seen > allowed
        })
        .collect())
}

pub(crate) fn tsconfig_error_diagnostic(
    diag: P<tsrs_ast::Diagnostic>,
    config_file_name: &str,
) -> Diagnostic {
    let file_path = diag
        .file()
        .map(|file| file.file_name().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| config_file_name.to_string());
    let help = tsrs_compiler::diagnosticwriter::flatten_diagnostic_message(diag, "\n");
    Diagnostic {
        kind: 1,
        range: diag.loc().map(Range::from),
        message: Message {
            id: "tsconfig-error".to_string(),
            description: "Invalid tsconfig".to_string(),
            help: Some(help),
        },
        file_path: Some(file_path),
        labeled_ranges: Vec::new(),
        rule: None,
        fixes: Vec::new(),
        suggestions: Vec::new(),
    }
}

pub(crate) fn inferred_compiler_options() -> CompilerOptions {
    CompilerOptions {
        allow_js: Tristate::True,
        module: ModuleKind::ESNext,
        module_resolution: ModuleResolutionKind::Bundler,
        target: ScriptTarget::ES2022,
        jsx: JsxEmit::ReactJSX,
        allow_importing_ts_extensions: Tristate::True,
        strict_null_checks: Tristate::True,
        strict_function_types: Tristate::True,
        source_map: Tristate::True,
        es_module_interop: Tristate::True,
        allow_non_ts_extensions: Tristate::True,
        resolve_json_module: Tristate::True,
        ..Default::default()
    }
}
