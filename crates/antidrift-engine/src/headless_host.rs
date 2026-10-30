use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicU32, Ordering};
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

static PROGRAMS_BUILT: AtomicU32 = AtomicU32::new(0);
static PROGRAMS_REUSED: AtomicU32 = AtomicU32::new(0);

pub(crate) fn program_counts() -> (u32, u32) {
    (
        PROGRAMS_BUILT.load(Ordering::Relaxed),
        PROGRAMS_REUSED.load(Ordering::Relaxed),
    )
}

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
        .map(|file| file.file_name().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| config_file_name.to_owned());
    let help = tsrs_compiler::diagnosticwriter::flatten_diagnostic_message(diag, "\n");
    Diagnostic {
        kind: 1,
        range: diag.loc().map(Range::from),
        message: Message {
            id: "tsconfig-error".to_owned(),
            description: "Invalid tsconfig".to_owned(),
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

struct CachedProgram {
    program: &'static Program,
    diagnostics: Vec<Diagnostic>,
}

struct ProgramFactory {
    cwd: String,
    fs: Arc<dyn FS>,
    ext_cache: &'static ExtendedConfigCache,
    declarations: &'static DeclarationCache,
    resolver: TsConfigResolver,
}

impl ProgramFactory {
    fn configured(&self, config_file_name: &str) -> Result<CachedProgram, Vec<Diagnostic>> {
        let parsed = self.resolver.load(config_file_name);
        let config = match parsed.config {
            Some(config) if parsed.errors.is_empty() => config,
            _ => {
                return Err(parsed
                    .errors
                    .iter()
                    .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                    .collect());
            }
        };
        let config_errors: Vec<Diagnostic> = config
            .errors
            .iter()
            .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
            .collect();
        let compiler_host =
            build_shared_host(&self.cwd, &self.fs, self.ext_cache, self.declarations);
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.use_source_of_project_reference = true;
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        PROGRAMS_BUILT.fetch_add(1, Ordering::Relaxed);
        let diagnostics = if config_errors.is_empty() {
            program
                .get_program_diagnostics()
                .iter()
                .map(|diag| tsconfig_error_diagnostic(*diag, config_file_name))
                .collect()
        } else {
            config_errors
        };
        program.bind_source_files();
        Ok(CachedProgram {
            program,
            diagnostics,
        })
    }

    fn inferred(&self, unmatched: &[String]) -> &'static Program {
        let compiler_host =
            build_shared_host(&self.cwd, &self.fs, self.ext_cache, self.declarations);
        let config = P::new(tsrs_tsoptions::new_parsed_command_line(
            P::new(inferred_compiler_options()),
            unmatched.to_vec(),
            Vec::new(),
            tspath::ComparePathsOptions {
                use_case_sensitive_file_names: self.fs.use_case_sensitive_file_names(),
                current_directory: self.cwd.clone(),
            },
        ));
        let mut popts = ProgramOptions::new(config, compiler_host);
        popts.single_threaded = Tristate::False;
        let program = new_program(popts);
        PROGRAMS_BUILT.fetch_add(1, Ordering::Relaxed);
        program.bind_source_files();
        program
    }

    fn report(
        &self,
        cached: &CachedProgram,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Result<BoundProgram, Vec<Diagnostic>> {
        if !suppress_program_diagnostics && !cached.diagnostics.is_empty() {
            return Err(cached.diagnostics.clone());
        }
        Ok(self.bind(
            cached.program,
            &tspath::get_directory_path(config_file_name),
            config_files,
        ))
    }

    fn bind(&self, program: &'static Program, base_dir: &str, files: &[String]) -> BoundProgram {
        let use_case = self.fs.use_case_sensitive_file_names();
        let wanted: FxHashSet<Path> = files
            .iter()
            .map(|file| tspath::to_path(file, base_dir, use_case))
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

fn matches_disk(program: &Program) -> bool {
    let disk = osvfs::fs();
    program
        .source_files()
        .iter()
        .filter(|sf| {
            !program.is_lib_file(**sf) && !program.is_source_file_from_external_library(**sf)
        })
        .all(|sf| {
            disk.read_file(sf.file_name())
                .is_some_and(|text| text == sf.text())
        })
}

pub(crate) struct ProgramBuilderEnv {
    factory: ProgramFactory,
    configured: FxHashMap<String, CachedProgram>,
}

impl ProgramBuilderEnv {
    pub(crate) fn new(fs: Arc<dyn FS>, cwd: &str) -> Self {
        let host: &'static ParseHost = Box::leak(Box::new(ParseHost {
            fs: Arc::clone(&fs),
            cwd: cwd.to_owned(),
        }));
        let ext_cache: &'static ExtendedConfigCache = Box::leak(Box::default());
        let declarations: &'static DeclarationCache = Box::leak(Box::default());
        let resolver = TsConfigResolver::new(host, ext_cache);
        Self {
            factory: ProgramFactory {
                cwd: cwd.to_owned(),
                fs,
                ext_cache,
                declarations,
                resolver,
            },
            configured: FxHashMap::default(),
        }
    }

    pub(crate) fn group_files_by_tsconfig(
        &self,
        files: &[String],
    ) -> (Vec<(String, Vec<String>)>, Vec<String>) {
        let assignment = self.factory.resolver.resolve_all(files);
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

    pub(crate) fn configured_program(
        &mut self,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Result<BoundProgram, Vec<Diagnostic>> {
        let cached = match self.configured.entry(config_file_name.to_owned()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(self.factory.configured(config_file_name)?),
        };
        self.factory.report(
            cached,
            config_file_name,
            config_files,
            suppress_program_diagnostics,
        )
    }

    pub(crate) fn current_program(
        &self,
        config_file_name: &str,
        config_files: &[String],
        suppress_program_diagnostics: bool,
    ) -> Option<Result<BoundProgram, Vec<Diagnostic>>> {
        let cached = self
            .configured
            .get(config_file_name)
            .filter(|cached| matches_disk(cached.program))?;
        PROGRAMS_REUSED.fetch_add(1, Ordering::Relaxed);
        Some(self.factory.report(
            cached,
            config_file_name,
            config_files,
            suppress_program_diagnostics,
        ))
    }

    pub(crate) fn inferred_program(&self, unmatched: &[String]) -> BoundProgram {
        let program = self.factory.inferred(unmatched);
        self.factory.bind(program, &self.factory.cwd, unmatched)
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
