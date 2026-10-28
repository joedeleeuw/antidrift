use std::sync::{Arc, Mutex};

use rustc_hash::{FxHashMap, FxHashSet};
use tsrs_ast::{SourceFile, SourceFileParseOptions};
use tsrs_compiler::{CompilerHost, Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::tspath::{self, Path};
use tsrs_core::{
    CompilerOptions, JsxEmit, ModuleKind, ModuleResolutionKind, P, ScriptTarget, Tristate,
};
use tsrs_vfs::{FS, bundled, cachedvfs, osvfs};
use tsrslint::overlayfs::OverlayFS;
use tsrslint::protocol::{Diagnostic, Message, Payload, Range};
use tsrslint::tsconfig::{ExtendedConfigCache, ParseHost, TsConfigResolver};

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

pub(crate) struct BoundProgram {
    pub(crate) program: &'static Program,
    pub(crate) source_files: Vec<P<SourceFile>>,
}

pub(crate) struct ProgramBuilderEnv {
    cwd: String,
    fs: Arc<dyn FS>,
    ext_cache: &'static ExtendedConfigCache,
    declarations: &'static DeclarationCache,
    resolver: TsConfigResolver,
}

impl ProgramBuilderEnv {
    pub(crate) fn new(fs: Arc<dyn FS>, cwd: &str) -> Self {
        let host: &'static ParseHost = Box::leak(Box::new(ParseHost {
            fs: Arc::clone(&fs),
            cwd: cwd.to_string(),
        }));
        let ext_cache: &'static ExtendedConfigCache = Box::leak(Box::default());
        let declarations: &'static DeclarationCache = Box::leak(Box::default());
        let resolver = TsConfigResolver::new(host, ext_cache);
        Self {
            cwd: cwd.to_string(),
            fs,
            ext_cache,
            declarations,
            resolver,
        }
    }

    pub(crate) fn group_files_by_tsconfig(
        &self,
        files: &[String],
    ) -> (Vec<(String, Vec<String>)>, Vec<String>) {
        let assignment = self.resolver.resolve_all(files);
        let mut programs: Vec<(String, Vec<String>)> = Vec::new();
        let mut program_index: FxHashMap<String, usize> = FxHashMap::default();
        let mut unmatched: Vec<String> = Vec::new();
        for (file, config) in files.iter().zip(assignment) {
            if config.is_empty() {
                unmatched.push(file.clone());
                continue;
            }
            let idx = *program_index.entry(config.clone()).or_insert_with(|| {
                programs.push((config.clone(), Vec::new()));
                programs.len() - 1
            });
            programs[idx].1.push(file.clone());
        }
        (programs, unmatched)
    }

    pub(crate) fn run_configured_program(
        &self,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Result<BoundProgram, Vec<Diagnostic>> {
        let parsed = self.resolver.load(config_file_name);
        let Some(config) = parsed.config else {
            return Err(parsed
                .errors
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect());
        };
        if !parsed.errors.is_empty() {
            return Err(parsed
                .errors
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect());
        }
        if !config.errors.is_empty() && !suppress_program_diagnostics {
            return Err(config
                .errors
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect());
        }
        let dir = tspath::get_directory_path(config_file_name);
        let compiler_host = build_shared_host(&dir, &self.fs, self.ext_cache, self.declarations);
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.use_source_of_project_reference = true;
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        let program_diags = program.get_program_diagnostics();
        if !program_diags.is_empty() && !suppress_program_diagnostics {
            return Err(program_diags
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect());
        }
        program.bind_source_files();
        let use_case = self.fs.use_case_sensitive_file_names();
        let wanted: FxHashSet<Path> = config_files
            .iter()
            .map(|file| tspath::to_path(file, &dir, use_case))
            .collect();
        let source_files: Vec<P<SourceFile>> = program
            .source_files()
            .iter()
            .copied()
            .filter(|sf| wanted.contains(sf.path()))
            .collect();
        Ok(BoundProgram {
            program,
            source_files,
        })
    }

    pub(crate) fn build_inferred_program(&self, unmatched: &[String]) -> BoundProgram {
        let compiler_host =
            build_shared_host(&self.cwd, &self.fs, self.ext_cache, self.declarations);
        let use_case = self.fs.use_case_sensitive_file_names();
        let config = P::new(tsrs_tsoptions::new_parsed_command_line(
            P::new(inferred_compiler_options()),
            unmatched.to_vec(),
            Vec::new(),
            tspath::ComparePathsOptions {
                use_case_sensitive_file_names: use_case,
                current_directory: self.cwd.clone(),
            },
        ));
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        program.bind_source_files();
        let wanted: FxHashSet<Path> = unmatched
            .iter()
            .map(|file| tspath::to_path(file, &self.cwd, use_case))
            .collect();
        let source_files: Vec<P<SourceFile>> = program
            .source_files()
            .iter()
            .copied()
            .filter(|sf| wanted.contains(sf.path()))
            .collect();
        BoundProgram {
            program,
            source_files,
        }
    }
}

pub(crate) fn collect_missing_bound_files(
    source_files: &[P<SourceFile>],
    config_files: &[String],
    unmatched: &mut Vec<String>,
) {
    let bound_names: FxHashSet<String> = source_files
        .iter()
        .map(|sf| tspath::normalize_slashes(sf.file_name()))
        .collect();
    for requested in config_files {
        if !bound_names.contains(&tspath::normalize_slashes(requested)) {
            unmatched.push(requested.clone());
        }
    }
}
